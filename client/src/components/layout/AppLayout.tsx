/**
 * AppLayout — Discord benzeri 3-panel ana layout.
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │ Sidebar (240px) │    Chat Area (flex)     │ MemberList (240px) │
 * │                 │                         │                    │
 * │ - Server name   │ - Channel header        │ - Online users     │
 * │ - Categories    │ - Messages              │ - Offline users    │
 * │ - Channels      │ - Message input         │                    │
 * │                 │                         │                    │
 * │ ─────────────── │                         │                    │
 * │ User bar (alt)  │                         │                    │
 * └─────────────────────────────────────────────────────────────┘
 *
 * useWebSocket hook'u burada çağrılır — tüm WS event'leri
 * bu noktadan store'lara yönlendirilir.
 */

import Sidebar from "./Sidebar";
import ChatArea from "./ChatArea";
import MemberList from "./MemberList";
import { useWebSocket } from "../../hooks/useWebSocket";

function AppLayout() {
  const { sendTyping } = useWebSocket();

  return (
    <div className="flex h-full">
      {/* Sol sidebar — kanal listesi */}
      <Sidebar />

      {/* Orta alan — mesajlar */}
      <ChatArea sendTyping={sendTyping} />

      {/* Sağ panel — üye listesi */}
      <MemberList />
    </div>
  );
}

export default AppLayout;
