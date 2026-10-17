/**
 * CollapsedSidebar — 52px narrow sidebar with server/DM icons, unread badges, and user avatar.
 * Clicking any icon expands the sidebar.
 */

import { useSidebarStore } from "../../stores/sidebarStore";
import { useAuthStore } from "../../stores/authStore";
import { useServerStore } from "../../stores/serverStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useChannelStore } from "../../stores/channelStore";
import Avatar from "../shared/Avatar";
import { resolveAssetUrl } from "../../utils/constants";

function CollapsedSidebar() {
  const expandSidebar = useSidebarStore((s) => s.expandSidebar);
  const user = useAuthStore((s) => s.user);

  const activeServerId = useServerStore((s) => s.activeServerId);
  const servers = useServerStore((s) => s.servers);
  const activeServer = servers.find((s) => s.id === activeServerId) ?? null;

  const unreadCounts = useReadStateStore((s) => s.unreadCounts);
  const mutedChannelIds = useChannelStore((s) => s.mutedChannelIds);

  // Total channel unread for the active server (readStateStore is server-scoped)
  const totalChannelUnread = Object.entries(unreadCounts).reduce(
    (sum, [chId, c]) => mutedChannelIds.has(chId) ? sum : sum + c,
    0,
  );

  return (
    <div className="sb-collapsed">
      {/* Expand button */}
      <button
        className="sb-collapsed-btn sb-collapsed-expand"
        onClick={expandSidebar}
        data-tour="sidebar-expand"
        title="Expand sidebar"
      >
        &#x276F;
      </button>

      {/* Active server icon */}
      {activeServer && (
        <button
          className="sb-collapsed-btn sb-collapsed-server"
          onClick={expandSidebar}
          title={activeServer.name}
        >
          {activeServer.icon_url ? (
            <img
              src={resolveAssetUrl(activeServer.icon_url) ?? undefined}
              alt={activeServer.name}
              className="sb-collapsed-icon"
            />
          ) : (
            <span className="sb-collapsed-icon-fallback">
              {activeServer.name.charAt(0).toUpperCase()}
            </span>
          )}
          {totalChannelUnread > 0 && (
            <span className="sb-collapsed-badge">{totalChannelUnread}</span>
          )}
        </button>
      )}

      {/* Spacer */}
      <div className="sb-collapsed-spacer" />

      {/* User avatar */}
      {user && (
        <div className="sb-collapsed-avatar">
          <Avatar
            name={user.display_name || user.username}
            avatarUrl={user.avatar_url}
            size={28}
            isCircle
          />
        </div>
      )}
    </div>
  );
}

export default CollapsedSidebar;
