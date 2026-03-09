/** Single friend/request row. Modes: friend, incoming, outgoing. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import Avatar from "../shared/Avatar";
import ContextMenu from "../shared/ContextMenu";
import MemberCard from "../members/MemberCard";
import { useContextMenu, type ContextMenuItem } from "../../hooks/useContextMenu";
import type { FriendshipWithUser, User } from "../../types";

type FriendItemProps = {
  friendship: FriendshipWithUser;
  type: "friend" | "incoming" | "outgoing";
  onAccept?: () => void;
  onDecline?: () => void;
  onRemove?: () => void;
  onSendMessage?: () => void;
  onVoiceCall?: () => void;
  onVideoCall?: () => void;
};

function FriendItem({ friendship, type, onAccept, onDecline, onRemove, onSendMessage, onVoiceCall, onVideoCall }: FriendItemProps) {
  const { t } = useTranslation("common");
  const { menuState, openMenu, closeMenu } = useContextMenu();
  const [profileTarget, setProfileTarget] = useState<{ user: User; top: number; left: number } | null>(null);

  const displayName = friendship.display_name ?? friendship.username;
  const statusKey = friendship.user_status as string;

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const items = buildContextMenuItems(e);
    openMenu(e, items);
  }

  function buildContextMenuItems(e: React.MouseEvent): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      {
        label: t("viewProfile"),
        onClick: () => {
          const rect = (e.target as HTMLElement).getBoundingClientRect();
          setProfileTarget({
            user: friendshipToUser(friendship),
            top: rect.top,
            left: rect.right + 8,
          });
        },
      },
    ];

    if (type === "friend") {
      items.push(
        { label: t("voiceCall"), onClick: () => onVoiceCall?.() },
        { label: t("videoCall"), onClick: () => onVideoCall?.() },
      );

      if (onSendMessage) {
        items.push({ label: t("sendMessage"), onClick: onSendMessage });
      }

      if (onRemove) {
        items.push({ label: t("friendRemove"), onClick: onRemove, danger: true, separator: true });
      }
    }

    if (type === "incoming" && onAccept) {
      items.push({ label: t("friendAccept"), onClick: onAccept });
    }

    if ((type === "incoming" || type === "outgoing") && onDecline) {
      items.push({
        label: type === "outgoing" ? t("cancel") : t("friendDecline"),
        onClick: onDecline,
        danger: true,
      });
    }

    return items;
  }

  return (
    <>
      <div className="fi-item" onContextMenu={handleContextMenu}>
        {/* Avatar + info */}
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

        {/* Actions */}
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
            <>
              <button
                className="fi-btn fi-btn-call"
                onClick={onVoiceCall}
                title={t("voiceCall")}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 0 0-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z" />
                </svg>
              </button>
              <button
                className="fi-btn fi-btn-call"
                onClick={onVideoCall}
                title={t("videoCall")}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                </svg>
              </button>
              <button className="fi-btn fi-btn-msg" onClick={onSendMessage} title={t("sendMessage")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z" />
                </svg>
              </button>
              <button className="fi-btn fi-btn-remove" onClick={onRemove} title={t("friendRemove")}>
                &#10005;
              </button>
            </>
          )}
        </div>
      </div>

      <ContextMenu state={menuState} onClose={closeMenu} />

      {profileTarget && (
        <MemberCard
          user={profileTarget.user}
          position={{ top: profileTarget.top, left: profileTarget.left }}
          onClose={() => setProfileTarget(null)}
        />
      )}
    </>
  );
}

/** Convert FriendshipWithUser to User for MemberCard */
function friendshipToUser(f: FriendshipWithUser): User {
  return {
    id: f.user_id,
    username: f.username,
    display_name: f.display_name ?? null,
    avatar_url: f.avatar_url ?? null,
    status: (f.user_status ?? "offline") as User["status"],
    custom_status: f.user_custom_status ?? null,
    email: null,
    language: "en",
    is_platform_admin: false,
    created_at: f.created_at ?? new Date().toISOString(),
  };
}

export default FriendItem;
