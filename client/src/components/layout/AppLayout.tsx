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
 * Tailwind flex layout kullanıyoruz:
 * - Sidebar: sabit genişlik (w-[240px])
 * - ChatArea: kalan alanı doldurur (flex-1)
 * - MemberList: sabit genişlik (w-[240px]), toggle ile gizlenebilir
 */

import Sidebar from "./Sidebar";
import ChatArea from "./ChatArea";
import MemberList from "./MemberList";

function AppLayout() {
  return (
    <div className="flex h-full">
      {/* Sol sidebar — kanal listesi */}
      <Sidebar />

      {/* Orta alan — mesajlar */}
      <ChatArea />

      {/* Sağ panel — üye listesi */}
      <MemberList />
    </div>
  );
}

export default AppLayout;
