/**
 * DMList — DM kanal listesi popup'ı.
 *
 * Dock'taki 💬 Messages butonuna tıklandığında gösterilir.
 * Açık DM konuşmalarını listeler, tıklandığında DM tab'ı açar.
 *
 * CSS class'ları: .dm-list-popup, .dm-list-header, .dm-list-items,
 * .dm-list-item, .dm-list-item.active, .dm-list-avatar, .dm-list-info,
 * .dm-list-name, .dm-list-preview, .dm-list-empty
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import Avatar from "../shared/Avatar";

type DMListProps = {
  onClose: () => void;
};

function DMList({ onClose }: DMListProps) {
  const { t } = useTranslation("chat");
  const channels = useDMStore((s) => s.channels);
  const isLoading = useDMStore((s) => s.isLoading);
  const dmUnreadCounts = useDMStore((s) => s.dmUnreadCounts);
  const openTab = useUIStore((s) => s.openTab);

  /** DM kanalına tıklandığında tab aç ve popup'ı kapat */
  function handleChannelClick(channelId: string, displayName: string) {
    openTab(channelId, "dm", displayName);
    onClose();
  }

  /** Dış tıklama ile kapatma */
  useEffect(() => {
    let frameId: number;

    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest(".dm-list-popup") && !target.closest(".dock-item")) {
        onClose();
      }
    }

    frameId = requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
    });

    return () => {
      cancelAnimationFrame(frameId);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  return (
    <div className="dm-list-popup">
      {/* Header */}
      <div className="dm-list-header">
        <span>{t("directMessages")}</span>
      </div>

      {/* Channel list */}
      <div className="dm-list-items">
        {isLoading && channels.length === 0 && (
          <div className="dm-list-empty">{t("loading", { ns: "common" })}</div>
        )}

        {!isLoading && channels.length === 0 && (
          <div className="dm-list-empty">{t("noDMs")}</div>
        )}

        {channels.map((ch) => {
          const other = ch.other_user;
          const displayName = other?.display_name ?? other?.username ?? "?";
          const unread = dmUnreadCounts[ch.id] ?? 0;

          return (
            <button
              key={ch.id}
              className={`dm-list-item${unread > 0 ? " has-unread" : ""}`}
              onClick={() => handleChannelClick(ch.id, displayName)}
            >
              <div className="dm-list-avatar">
                <Avatar
                  name={displayName}
                  avatarUrl={other?.avatar_url ?? undefined}
                  size={28}
                />
              </div>
              <div className="dm-list-info">
                <span className="dm-list-name">{displayName}</span>
              </div>
              {unread > 0 && (
                <span className="dm-unread-badge">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default DMList;
