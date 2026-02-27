/**
 * AppLayout — Sidebar-based ana layout.
 *
 * ┌─────────┬──────────────────────┬─────────┐
 * │ Sidebar │ SplitPaneContainer   │ Members │
 * │ (240px) │ (flex-1, recursive)  │ (240px) │
 * │         │ Her panel kendi      │         │
 * │         │ PanelTabBar'ına sahip│         │
 * └─────────┴──────────────────────┴─────────┘
 *
 * useWebSocket hook'u burada çağrılır — tüm WS event'leri
 * bu noktadan store'lara yönlendirilir.
 *
 * useVoice hook'u burada çağrılır — voice join/leave/mute/deafen
 * orkestrasyon fonksiyonları Sidebar/UserBar'a prop olarak geçilir.
 *
 * CSS: .mqvi-app, .app-body, .main-area
 */

import { useEffect, useRef } from "react";
import SplitPaneContainer from "./SplitPaneContainer";
import MemberList from "./MemberList";
import Sidebar from "./Sidebar";
import ToastContainer from "../shared/ToastContainer";
import ConfirmDialog from "../shared/ConfirmDialog";
import SettingsModal from "../settings/SettingsModal";
import VoiceProvider from "../voice/VoiceProvider";
import { useWebSocket } from "../../hooks/useWebSocket";
import { useVoice } from "../../hooks/useVoice";
import { useIdleDetection } from "../../hooks/useIdleDetection";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useP2PCall } from "../../hooks/useP2PCall";
import IncomingCallOverlay from "../p2p/IncomingCallOverlay";
import QuickSwitcher from "../shared/QuickSwitcher";
import ScreenPicker from "../voice/ScreenPicker";
import { useServerStore } from "../../stores/serverStore";
import { useChannelStore } from "../../stores/channelStore";
import { useMemberStore } from "../../stores/memberStore";
import { useUIStore } from "../../stores/uiStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useMessageStore } from "../../stores/messageStore";
import { useReadStateStore } from "../../stores/readStateStore";

function AppLayout() {
  const { sendTyping, sendDMTyping, sendPresenceUpdate, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate, sendWS } =
    useWebSocket();

  // Idle detection — 5dk inaktiflik → "idle", aktivite geri gelince → "online"
  useIdleDetection({ sendPresenceUpdate });
  const fetchServer = useServerStore((s) => s.fetchServer);
  const fetchChannels = useChannelStore((s) => s.fetchChannels);
  const fetchMembers = useMemberStore((s) => s.fetchMembers);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const categories = useChannelStore((s) => s.categories);
  const layout = useUIStore((s) => s.layout);
  const openTab = useUIStore((s) => s.openTab);

  /**
   * autoOpenedRef — İlk kanal seçildiğinde otomatik tab açılmasını
   * tek seferlik yapar. Birden fazla çağrıyı engeller.
   */
  const autoOpenedRef = useRef(false);

  // Sunucu, kanal ve üye bilgilerini uygulama başlatıldığında çek
  useEffect(() => {
    fetchServer();
    fetchChannels();
    fetchMembers();
  }, [fetchServer, fetchChannels, fetchMembers]);

  /**
   * Kanallar yüklendikten sonra ilk text kanalını otomatik tab olarak aç.
   * channelStore.fetchChannels zaten selectedChannelId'yi setiyor —
   * burada sadece UI tab'ını açıyoruz.
   */
  useEffect(() => {
    if (!selectedChannelId || autoOpenedRef.current) return;
    if (categories.length === 0) return;

    const channel = categories
      .flatMap((cg) => cg.channels)
      .find((ch) => ch.id === selectedChannelId);

    if (channel) {
      openTab(
        channel.id,
        channel.type === "text" ? "text" : "voice",
        channel.name
      );
      autoOpenedRef.current = true;
    }
  }, [selectedChannelId, categories, openTab]);

  /**
   * Auto-mark-read — Kanal değiştiğinde okunmamış sayacını sıfırla.
   *
   * Aktif kanala geçildiğinde, o kanalın son mesajı varsa backend'e
   * "bu mesaja kadar okudum" bilgisi gönderilir ve local badge sıfırlanır.
   */
  useEffect(() => {
    if (!selectedChannelId) return;

    const messages = useMessageStore.getState().messagesByChannel[selectedChannelId];
    if (messages && messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      useReadStateStore.getState().markAsRead(selectedChannelId, lastMessage.id);
    } else {
      // Mesajlar henüz yüklenmemiş olabilir — local badge'i yine sıfırla
      useReadStateStore.getState().clearUnread(selectedChannelId);
    }
  }, [selectedChannelId]);

  const { joinVoice, leaveVoice, toggleMute, toggleDeafen, toggleScreenShare } = useVoice({
    sendVoiceJoin,
    sendVoiceLeave,
    sendVoiceStateUpdate,
  });

  // Global keyboard shortcuts — Ctrl+K, Ctrl+Shift+M, Ctrl+Shift+D
  useKeyboardShortcuts({ toggleMute, toggleDeafen });

  // P2P call lifecycle — incoming call timeout, WebRTC negotiation, tab sync
  useP2PCall();

  // ─── Voice ↔ Tab sync ───

  /**
   * leaveVoice callback'ini voiceStore'a kaydet.
   * uiStore.closeTab bir voice tab kapatıldığında bu callback'i çağırır —
   * böylece hem WS voice_leave event'i gönderilir hem de store temizlenir.
   *
   * Cleanup'ta null'a set ederiz — component unmount olursa stale callback kalmasın.
   */
  useEffect(() => {
    useVoiceStore.getState().registerOnLeave(leaveVoice);
    return () => {
      useVoiceStore.getState().registerOnLeave(null);
    };
  }, [leaveVoice]);

  // sendWS callback'ini voiceStore'a kaydet — VoiceUserContextMenu gibi
  // deep component'ler prop drilling olmadan WS event gönderebilsin.
  useEffect(() => {
    useVoiceStore.getState().registerWsSend(sendWS);
    return () => {
      useVoiceStore.getState().registerWsSend(null);
    };
  }, [sendWS]);

  /**
   * Voice leave → tab close sync.
   *
   * currentVoiceChannelId değişikliğini takip eder:
   * - Bir değerden null'a geçiş = voice kanalından ayrılma
   * - Bu durumda o kanala ait voice/screen tab'larını kapatır
   *
   * prevRef ile önceki değeri tutarız — React'in useEffect cleanup'ı
   * yeterli değil çünkü önceki değeri bilmemiz lazım.
   */
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const prevVoiceChannelRef = useRef<string | null>(null);

  useEffect(() => {
    const prev = prevVoiceChannelRef.current;
    prevVoiceChannelRef.current = currentVoiceChannelId;

    // Voice kanalından ayrıldıysa → ilgili tab'ları kapat
    if (prev && !currentVoiceChannelId) {
      useUIStore.getState().closeVoiceTabs(prev);
    }
  }, [currentVoiceChannelId]);

  return (
    <div className="mqvi-app">
      {/* Sol sidebar — kanal ağacı + voice kontrolleri */}
      <Sidebar
        onJoinVoice={joinVoice}
        onToggleMute={toggleMute}
        onToggleDeafen={toggleDeafen}
        onToggleScreenShare={toggleScreenShare}
        onDisconnect={leaveVoice}
        sendPresenceUpdate={sendPresenceUpdate}
      />

      {/* Sağ taraf — split paneller + member list */}
      {/* VoiceProvider: LiveKit bağlantısını her zaman mount tutar.
          Tab değişince VoiceRoom visual component'i unmount olsa bile
          ses bağlantısı korunur. display:contents ile layout etkilenmez. */}
      <VoiceProvider>
        <div className="app-body">
          {/* Ana içerik alanı — split paneller + member list */}
          <div className="main-area">
            {/* Split pane container — recursive layout ağacını render eder */}
            <SplitPaneContainer node={layout} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />

            {/* Sağ panel — CSS transition ile açılıp kapanır (.members-panel.open) */}
            <MemberList />
          </div>
        </div>
      </VoiceProvider>

      {/* Settings modal — tam ekran overlay (z-50) */}
      <SettingsModal />

      {/* Onay dialogu — window.confirm() yerine (z-50) */}
      <ConfirmDialog />

      {/* Toast notifications — sağ alt köşe (z-100) */}
      <ToastContainer />

      {/* Quick Switcher — Ctrl+K ile açılır (z-60) */}
      <QuickSwitcher />

      {/* P2P gelen arama overlay — z-200, en üst katman */}
      <IncomingCallOverlay />

      {/* Electron screen picker — getDisplayMedia tetiklendiğinde açılır (z-150) */}
      <ScreenPicker />
    </div>
  );
}

export default AppLayout;
