/**
 * FriendItem — Tek bir arkadaş/istek satırı.
 *
 * Üç kullanım modu:
 * - friend: Avatar + isim + durum + "Remove" butonu
 * - incoming: Avatar + isim + "Accept" + "Decline" butonları
 * - outgoing: Avatar + isim + "Cancel" butonu
 *
 * CSS class'ları: .fi-item, .fi-info, .fi-avatar, .fi-name, .fi-username,
 * .fi-status, .fi-actions, .fi-btn, .fi-btn-accept, .fi-btn-decline, .fi-btn-remove
 */

import { useTranslation } from "react-i18next";
import Avatar from "../shared/Avatar";
import type { FriendshipWithUser } from "../../types";

type FriendItemProps = {
  friendship: FriendshipWithUser;
  type: "friend" | "incoming" | "outgoing";
  onAccept?: () => void;
  onDecline?: () => void;
  onRemove?: () => void;
};

function FriendItem({ friendship, type, onAccept, onDecline, onRemove }: FriendItemProps) {
  const { t } = useTranslation("common");

  const displayName = friendship.display_name ?? friendship.username;
  const statusKey = friendship.user_status as string;

  return (
    <div className="fi-item">
      {/* Sol: Avatar + bilgi */}
      <div className="fi-info">
        <Avatar
          name={displayName}
          avatarUrl={friendship.avatar_url ?? undefined}
          size={36}
          isCircle
        />
        <div className="fi-text">
          <span className="fi-name">{displayName}</span>
          <span className="fi-username">@{friendship.username}</span>
          {type === "friend" && (
            <span className={`fi-status fi-status-${friendship.user_status}`}>
              {t(statusKey)}
              {friendship.user_custom_status && ` — ${friendship.user_custom_status}`}
            </span>
          )}
        </div>
      </div>

      {/* Sağ: Aksiyon butonları */}
      <div className="fi-actions">
        {type === "incoming" && (
          <>
            <button className="fi-btn fi-btn-accept" onClick={onAccept} title={t("friendAccept")}>
              &#10003;
            </button>
            <button className="fi-btn fi-btn-decline" onClick={onDecline} title={t("friendDecline")}>
              &#10005;
            </button>
          </>
        )}
        {type === "outgoing" && (
          <button className="fi-btn fi-btn-decline" onClick={onDecline} title={t("cancel")}>
            &#10005;
          </button>
        )}
        {type === "friend" && (
          <button className="fi-btn fi-btn-remove" onClick={onRemove} title={t("friendRemove")}>
            &#10005;
          </button>
        )}
      </div>
    </div>
  );
}

export default FriendItem;
