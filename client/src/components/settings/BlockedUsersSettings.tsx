/** BlockedUsersSettings — View and unblock blocked users. */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useBlockStore } from "../../stores/blockStore";
import * as blockApi from "../../api/block";
import Avatar from "../shared/Avatar";
import type { FriendshipWithUser } from "../../types";

function BlockedUsersSettings() {
  const { t } = useTranslation("settings");
  const unblockUser = useBlockStore((s) => s.unblockUser);
  const [blockedUsers, setBlockedUsers] = useState<FriendshipWithUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    blockApi.listBlocked().then((res) => {
      if (cancelled) return;
      if (res.success && res.data) {
        setBlockedUsers(res.data);
      }
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  async function handleUnblock(userId: string) {
    const ok = await unblockUser(userId);
    if (ok) {
      setBlockedUsers((prev) => prev.filter((u) => u.user_id !== userId));
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("blockedUsers")}</h2>
      <p className="settings-section-desc">{t("blockedUsersDesc")}</p>

      {isLoading ? (
        <div className="settings-loading">{t("loading")}</div>
      ) : blockedUsers.length === 0 ? (
        <div className="settings-empty">{t("noBlockedUsers")}</div>
      ) : (
        <div className="blocked-users-list">
          {blockedUsers.map((user) => {
            const name = user.display_name || user.username;
            return (
              <div key={user.user_id} className="blocked-user-item">
                <Avatar
                  name={name}
                  avatarUrl={user.avatar_url}
                  size={36}
                  isCircle
                />
                <div className="blocked-user-info">
                  <span className="blocked-user-name">{name}</span>
                  <span className="blocked-user-username">@{user.username}</span>
                </div>
                <button
                  className="blocked-user-unblock"
                  onClick={() => handleUnblock(user.user_id)}
                >
                  {t("unblock")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default BlockedUsersSettings;
