/**
 * Sidebar — Discord-style sol sidebar ana container.
 *
 * İki modda çalışır:
 * - **Expanded** (kullanıcı ayarlı genişlik, min 180 / max 400px):
 *   SidebarHeader + ChannelTree + UserBar
 * - **Collapsed** (52px): CollapsedSidebar (server icon + badges)
 *
 * Sağ kenarda resize handle ile genişlik sürüklenebilir.
 * Genişlik localStorage("mqvi_sidebar_width") ile persist edilir.
 *
 * Voice kontrol prop'ları AppLayout'tan gelir ve UserBar'a iletilir.
 * ChannelTree'ye onJoinVoice prop'u iletilir.
 *
 * CSS class'ları: .sidebar, .sidebar-inner, .resize-handle, .resize-handle.active
 */

import { useSidebarStore } from "../../stores/sidebarStore";
import { useResizeHandle } from "../../hooks/useResizeHandle";
import { useIsMobile } from "../../hooks/useMediaQuery";
import SidebarHeader from "./SidebarHeader";
import ChannelTree from "./ChannelTree";
import CollapsedSidebar from "./CollapsedSidebar";
import UserBar from "./UserBar";
import type { UserStatus } from "../../types";

/** Sidebar genişlik sınırları (px) */
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

  // Mobilde sidebar her zaman expanded — drawer içinde collapsed mantıksız
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

      {/* Resize handle — sağ kenarda dikey çizgi, sürüklenebilir */}
      <div
        className={`resize-handle resize-handle-v${isDragging ? " active" : ""}`}
        onMouseDown={handleMouseDown}
      />
    </div>
  );
}

export default Sidebar;
