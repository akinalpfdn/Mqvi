/**
 * Sidebar — Discord-style sol sidebar ana container.
 *
 * İki modda çalışır:
 * - **Expanded** (240px): SidebarHeader + ChannelTree + UserBar
 * - **Collapsed** (52px): CollapsedSidebar (server icon + badges)
 *
 * Geçiş: CSS transition ile width animasyonu (0.2s)
 *
 * Voice kontrol prop'ları AppLayout'tan gelir ve UserBar'a iletilir.
 * ChannelTree'ye onJoinVoice prop'u iletilir.
 *
 * CSS class'ları: .sidebar, .sidebar.collapsed, .sidebar-inner
 */

import { useSidebarStore } from "../../stores/sidebarStore";
import SidebarHeader from "./SidebarHeader";
import ChannelTree from "./ChannelTree";
import CollapsedSidebar from "./CollapsedSidebar";
import UserBar from "./UserBar";

type SidebarProps = {
  onJoinVoice: (channelId: string) => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onDisconnect: () => void;
};

function Sidebar({
  onJoinVoice,
  onToggleMute,
  onToggleDeafen,
  onToggleScreenShare,
  onDisconnect,
}: SidebarProps) {
  const isExpanded = useSidebarStore((s) => s.isExpanded);

  if (!isExpanded) {
    return <CollapsedSidebar />;
  }

  return (
    <div className="sidebar">
      <div className="sidebar-inner">
        <SidebarHeader />
        <ChannelTree onJoinVoice={onJoinVoice} />
        <UserBar
          onToggleMute={onToggleMute}
          onToggleDeafen={onToggleDeafen}
          onToggleScreenShare={onToggleScreenShare}
          onDisconnect={onDisconnect}
        />
      </div>
    </div>
  );
}

export default Sidebar;
