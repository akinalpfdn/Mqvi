/**
 * AppLayout — Discord benzeri 3-panel ana layout.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ Sidebar (240px)      │  Chat / Voice Area (flex)  │ MemberList │
 * │                      │                            │  (240px)   │
 * │ - Server name        │ - Channel header           │            │
 * │ - Categories         │ - Messages / VoiceRoom     │            │
 * │ - Channels (+voice)  │ - Message input            │            │
 * │                      │                            │            │
 * │ - VoiceControls      │                            │            │
 * │ - User bar           │                            │            │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * useWebSocket hook'u burada çağrılır — tüm WS event'leri
 * bu noktadan store'lara yönlendirilir.
 *
 * useVoice hook'u burada çağrılır — voice join/leave/mute/deafen
 * orkestrasyon fonksiyonları child component'lere prop olarak geçilir.
 */

import { useEffect } from "react";
import Sidebar from "./Sidebar";
import ChatArea from "./ChatArea";
import MemberList from "./MemberList";
import ToastContainer from "../shared/ToastContainer";
import SettingsModal from "../settings/SettingsModal";
import { useWebSocket } from "../../hooks/useWebSocket";
import { useVoice } from "../../hooks/useVoice";
import { useServerStore } from "../../stores/serverStore";

function AppLayout() {
  const { sendTyping, sendVoiceJoin, sendVoiceLeave, sendVoiceStateUpdate } =
    useWebSocket();
  const fetchServer = useServerStore((s) => s.fetchServer);

  // Sunucu bilgisini uygulama başlatıldığında çek
  useEffect(() => {
    fetchServer();
  }, [fetchServer]);

  const { joinVoice, leaveVoice, toggleMute, toggleDeafen, toggleScreenShare } = useVoice({
    sendVoiceJoin,
    sendVoiceLeave,
    sendVoiceStateUpdate,
  });

  return (
    <div className="flex h-full">
      {/* Sol sidebar — kanal listesi + voice controls */}
      <Sidebar
        onJoinVoice={joinVoice}
        onLeaveVoice={leaveVoice}
        onToggleMute={toggleMute}
        onToggleDeafen={toggleDeafen}
        onToggleScreenShare={toggleScreenShare}
      />

      {/* Orta alan — mesajlar veya voice room */}
      <ChatArea sendTyping={sendTyping} onJoinVoice={joinVoice} />

      {/* Sağ panel — üye listesi */}
      <MemberList />

      {/* Settings modal — tam ekran overlay (z-50) */}
      <SettingsModal />

      {/* Toast notifications — sağ alt köşe, tüm UI'ın üstünde (z-[100]) */}
      <ToastContainer />
    </div>
  );
}

export default AppLayout;
