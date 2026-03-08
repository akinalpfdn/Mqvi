/**
 * CollapsedSidebar — 52px narrow sidebar with server/DM icons, unread badges, and user avatar.
 * Clicking any icon expands the sidebar.
 */

import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useAuthStore } from "../../stores/authStore";
import { useDMStore } from "../../stores/dmStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useChannelStore } from "../../stores/channelStore";
import Avatar from "../shared/Avatar";
import { publicAsset } from "../../utils/constants";

function CollapsedSidebar() {
  const { t } = useTranslation("common");
  const expandSidebar = useSidebarStore((s) => s.expandSidebar);
  const user = useAuthStore((s) => s.user);

  const totalDMUnread = useDMStore((s) => s.getTotalDMUnread());
  const unreadCounts = useReadStateStore((s) => s.unreadCounts);
  const mutedChannelIds = useChannelStore((s) => s.mutedChannelIds);

  // Total channel unread count (excluding muted channels)
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
        title="Expand sidebar"
      >
        &#x276F;
      </button>

      {/* Server icon */}
      <button
        className="sb-collapsed-btn sb-collapsed-server"
        onClick={expandSidebar}
        title={t("server")}
      >
        <img src={publicAsset("mqvi-icon.svg")} alt="mqvi" className="sb-collapsed-icon" />
        {totalChannelUnread > 0 && (
          <span className="sb-collapsed-badge">{totalChannelUnread}</span>
        )}
      </button>

      {/* DM icon */}
      <button
        className="sb-collapsed-btn sb-collapsed-dm"
        onClick={expandSidebar}
        title={t("directMessages")}
      >
        &#x1F4AC;
        {totalDMUnread > 0 && (
          <span className="sb-collapsed-badge">{totalDMUnread}</span>
        )}
      </button>

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
