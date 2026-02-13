/**
 * AppLayout — Dock-based ana layout.
 *
 * ┌──────────────────────────────────────┐
 * │ TopBar (40px) — Server pill + Tabs    │
 * ├────────────────────────────┬─────────┤
 * │ SplitPaneContainer         │ Members │
 * │ (flex-1, recursive)        │ (200px) │
 * ├────────────────────────────┴─────────┤
 * │ Dock (bottom, centered)               │
 * └──────────────────────────────────────┘
 * VoicePopup (floating, draggable)
 *
 * useWebSocket hook'u burada çağrılır — tüm WS event'leri
 * bu noktadan store'lara yönlendirilir.
 *
 * useVoice hook'u burada çağrılır — voice join/leave/mute/deafen
 * orkestrasyon fonksiyonları child component'lere prop olarak geçilir.
 *
 * CSS: .mqvi-app, .main-area
 */

import { useEffect, useRef } from "react";
import TopBar from "./TopBar";
import SplitPaneContainer from "./SplitPaneContainer";
import MemberList from "./MemberList";
import Dock from "./Dock";
import VoicePopup from "../voice/VoicePopup";
import ToastContainer from "../shared/ToastContainer";
import SettingsModal from "../settings/SettingsModal";
import { useWebSocket } from "../../hooks/useWebSocket";
import { useVoice } from "../../hooks/useVoice";
import { useServerStore } from "../../stores/serverStore";
import { useChannelStore } from "../../stores/channelStore";
import { useMemberStore } from "../../stores/memberStore";
import { useUIStore } from "../../stores/uiStore";
import { useMessageStore } from "../../stores/messageStore";
import { useReadStateStore } from "../../stores/readStateStore";

function AppLayout() {
  const { sendTyping, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate } =
    useWebSocket();
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

  return (
    <div className="mqvi-app">
      {/* Üst bar — server pill + tab strip */}
      <TopBar />

      {/* Ana içerik alanı — split paneller + member list */}
      <div className="main-area">
        {/* Split pane container — recursive layout ağacını render eder */}
        <SplitPaneContainer node={layout} />

        {/* Sağ panel — CSS transition ile açılıp kapanır (.members-panel.open) */}
        <MemberList />
      </div>

      {/* Alt dock — kanal + sunucu ikonları */}
      <Dock onJoinVoice={joinVoice} />

      {/* Floating voice popup (ses bağlantısı varken görünür) */}
      <VoicePopup
        onToggleMute={toggleMute}
        onToggleDeafen={toggleDeafen}
        onToggleScreenShare={toggleScreenShare}
        onDisconnect={leaveVoice}
      />

      {/* Settings modal — tam ekran overlay (z-50) */}
      <SettingsModal />

      {/* Toast notifications — sağ alt köşe (z-100) */}
      <ToastContainer />
    </div>
  );
}

export default AppLayout;
