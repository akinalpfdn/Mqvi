/**
 * CollapsedSidebar — 52px genişliğinde daraltılmış sidebar.
 *
 * Gösterilecekler:
 * - Expand butonu (üstte)
 * - Server ikonu + unread badge
 * - DM ikonu + unread badge
 * - Alt kısımda kullanıcı avatarı
 *
 * Server ikonuna tıklanınca sidebar otomatik açılır.
 *
 * CSS class'ları: .sb-collapsed, .sb-collapsed-btn,
 * .sb-collapsed-icon, .sb-collapsed-badge, .sb-collapsed-avatar
 */

import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useAuthStore } from "../../stores/authStore";
import { useDMStore } from "../../stores/dmStore";
import { useReadStateStore } from "../../stores/readStateStore";
import Avatar from "../shared/Avatar";
import { publicAsset } from "../../utils/constants";

function CollapsedSidebar() {
  const { t } = useTranslation("common");
  const expandSidebar = useSidebarStore((s) => s.expandSidebar);
  const user = useAuthStore((s) => s.user);

  const totalDMUnread = useDMStore((s) => s.getTotalDMUnread());
  const unreadCounts = useReadStateStore((s) => s.unreadCounts);

  // Toplam kanal okunmamış sayısı
  const totalChannelUnread = Object.values(unreadCounts).reduce((sum, c) => sum + c, 0);

  return (
    <div className="sb-collapsed">
      {/* Expand butonu */}
      <button
        className="sb-collapsed-btn sb-collapsed-expand"
        onClick={expandSidebar}
        title="Expand sidebar"
      >
        &#x276F;
      </button>

      {/* Server ikonu */}
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

      {/* DM ikonu */}
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

      {/* Kullanıcı avatarı */}
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
