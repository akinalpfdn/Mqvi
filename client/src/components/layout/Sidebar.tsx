/**
 * Sidebar — Expanded (resizable 180-400px) or collapsed (52px).
 * Width persisted in localStorage. Voice control props forwarded to UserBar.
 */

import { useSidebarStore } from "../../stores/sidebarStore";
import { useResizeHandle } from "../../hooks/useResizeHandle";
import { useIsMobile } from "../../hooks/useMediaQuery";
import SidebarHeader from "./SidebarHeader";
import ChannelTree from "./ChannelTree";
import CollapsedSidebar from "./CollapsedSidebar";
import UserBar from "./UserBar";
import type { UserStatus } from "../../types";

/** Sidebar width bounds (px) */
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const SIDEBAR_DEFAULT = 240;

type SidebarProps = {
  onJoinVoice: (channelId: string) => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onDisconnect: () => void;
  sendPresenceUpdate: (status: UserStatus) => void;
};

function Sidebar({
  onJoinVoice,
  onToggleMute,
  onToggleDeafen,
  onToggleScreenShare,
  onDisconnect,
  sendPresenceUpdate,
}: SidebarProps) {
  const isExpanded = useSidebarStore((s) => s.isExpanded);
  const isMobile = useIsMobile();

  const { width, handleMouseDown, isDragging } = useResizeHandle({
    initialWidth: SIDEBAR_DEFAULT,
    minWidth: SIDEBAR_MIN,
    maxWidth: SIDEBAR_MAX,
    direction: "right",
    storageKey: "mqvi_sidebar_width",
  });

  // Always expanded on mobile (inside drawer)
  if (!isExpanded && !isMobile) {
    return <CollapsedSidebar />;
  }

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-inner" style={{ width }}>
        <SidebarHeader />
        <ChannelTree onJoinVoice={onJoinVoice} />
        <UserBar
          onToggleMute={onToggleMute}
          onToggleDeafen={onToggleDeafen}
          onToggleScreenShare={onToggleScreenShare}
          onDisconnect={onDisconnect}
          sendPresenceUpdate={sendPresenceUpdate}
        />
      </div>

      {/* Resize handle */}
      <div
        className={`resize-handle resize-handle-v${isDragging ? " active" : ""}`}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
}

export default Sidebar;
