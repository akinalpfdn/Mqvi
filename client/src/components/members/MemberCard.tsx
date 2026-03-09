/** MemberCard — Member profile popover, positioned left of MemberItem via portal. */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemberWithRoles } from "../../types";
import Avatar from "../shared/Avatar";
import RoleBadge from "./RoleBadge";
import RoleEditorPopup from "./RoleEditorPopup";
import BadgeAssignModal from "./BadgeAssignModal";
import BadgePill from "../shared/BadgePill";
import { useUserBadges } from "../../hooks/useUserBadges";
import { useAuthStore } from "../../stores/authStore";
import { useMemberStore } from "../../stores/memberStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { useFriendStore } from "../../stores/friendStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useConfirm } from "../../hooks/useConfirm";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as memberApi from "../../api/members";
import { useServerStore } from "../../stores/serverStore";

/** The user ID that can assign badges to other users. */
const BADGE_ADMIN_USER_ID = "95a8b295072f98a5";

type MemberCardProps = {
  member: MemberWithRoles;
  position: { top: number; left: number };
  onClose: () => void;
};

function MemberCard({ member, position, onClose }: MemberCardProps) {
  const { t } = useTranslation("common");
  const confirm = useConfirm();
  const cardRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState(position);
  const currentUser = useAuthStore((s) => s.user);

  const currentMember = useMemberStore((s) =>
    s.members.find((m) => m.id === currentUser?.id)
  );
  const myPerms = currentMember?.effective_permissions ?? 0;

  const friends = useFriendStore((s) => s.friends);
  const incoming = useFriendStore((s) => s.incoming);
  const outgoing = useFriendStore((s) => s.outgoing);

  const [showRoleEditor, setShowRoleEditor] = useState(false);
  const [showBadgeAssign, setShowBadgeAssign] = useState(false);

  const userBadges = useUserBadges(member.id);

  const isMe = currentUser?.id === member.id;
  const canKick = !isMe && hasPermission(myPerms, Permissions.KickMembers);
  const canBan = !isMe && hasPermission(myPerms, Permissions.BanMembers);
  const canManageRoles = !isMe && hasPermission(myPerms, Permissions.ManageRoles);
  const isBadgeAdmin = currentUser?.id === BADGE_ADMIN_USER_ID;
  const hasModActions = canKick || canBan || canManageRoles;

  // Friendship state
  const isFriend = friends.some((f) => f.user_id === member.id);
  const outReq = outgoing.find((r) => r.user_id === member.id);
  const inReq = incoming.find((r) => r.user_id === member.id);

  // Track whether a child modal (badge assign, role editor) is open via ref
  // so the click-outside handler can skip closing when a modal is active.
  const childModalOpenRef = useRef(false);
  childModalOpenRef.current = showBadgeAssign || showRoleEditor;

  // Measure card after render and clamp within viewport
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const pad = 8;
    let { top, left } = position;

    // Clamp bottom
    if (top + rect.height > window.innerHeight - pad) {
      top = window.innerHeight - rect.height - pad;
    }
    // Clamp top
    if (top < pad) top = pad;

    // Clamp left (card goes off-screen to the left)
    if (left < pad) left = pad;
    // Clamp right
    if (left + rect.width > window.innerWidth - pad) {
      left = window.innerWidth - rect.width - pad;
    }

    if (top !== position.top || left !== position.left) {
      setAdjustedPos({ top, left });
    }
  }, [position]);

  useEffect(() => {
    let frameId: number;

    function handleClick(e: MouseEvent) {
      // Don't close MemberCard if a child modal/popup is open
      if (childModalOpenRef.current) return;
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
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

  const sortedRoles = [...member.roles].sort(
    (a, b) => b.position - a.position
  );

  const joinDate = new Date(member.created_at).toLocaleDateString();

  async function handleKick() {
    const ok = await confirm({
      message: t("confirmKick", { username: member.username }),
      confirmLabel: t("kick"),
      danger: true,
    });
    if (!ok) return;
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    await memberApi.kickMember(serverId, member.id);
    onClose();
  }

  async function handleBan() {
    const ok = await confirm({
      message: t("confirmBan", { username: member.username }),
      confirmLabel: t("ban"),
      danger: true,
    });
    if (!ok) return;
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    await memberApi.banMember(serverId, member.id, "");
    onClose();
  }

  /** Open or create DM channel and switch to it */
  async function handleSendMessage() {
    const channelId = await useDMStore.getState().createOrGetChannel(member.id);
    if (channelId) {
      const displayName = member.display_name ?? member.username;
      useUIStore.getState().openTab(channelId, "dm", displayName);
    }
    onClose();
  }

  /** Open DM and start P2P voice call */
  async function handleCall() {
    const channelId = await useDMStore.getState().createOrGetChannel(member.id);
    if (channelId) {
      const displayName = member.display_name ?? member.username;
      useDMStore.getState().selectDM(channelId);
      useUIStore.getState().openTab(channelId, "dm", displayName);
    }
    useP2PCallStore.getState().initiateCall(member.id, "voice");
    onClose();
  }

  /** Context-aware friend action (add/remove/accept/cancel) */
  async function handleFriendAction() {
    if (isFriend) {
      const ok = await confirm({
        message: t("confirmRemoveFriend", { username: member.username }),
        confirmLabel: t("removeFriend"),
        danger: true,
      });
      if (ok) await useFriendStore.getState().removeFriend(member.id);
    } else if (outReq) {
      await useFriendStore.getState().declineRequest(outReq.id);
    } else if (inReq) {
      await useFriendStore.getState().acceptRequest(inReq.id);
    } else {
      await useFriendStore.getState().sendRequest(member.username);
    }
  }

  /** Friend button label based on current state */
  function getFriendLabel(): string {
    if (isFriend) return t("removeFriend");
    if (outReq) return t("cancelRequest");
    if (inReq) return t("acceptRequest");
    return t("addFriend");
  }

  /** Friend button icon SVG */
  function FriendIcon() {
    if (isFriend) {
      // Person remove
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="18" y1="11" x2="23" y2="11" />
        </svg>
      );
    }
    // Person add
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" /><circle cx="8.5" cy="7" r="4" /><line x1="20" y1="8" x2="20" y2="14" /><line x1="17" y1="11" x2="23" y2="11" />
      </svg>
    );
  }

  return (
    <>
      {/* Backdrop */}
      <div className="member-card-backdrop" onClick={onClose} />

      <div
        ref={cardRef}
        className="member-card"
        style={{ top: adjustedPos.top, left: adjustedPos.left }}
      >
        {/* Header bar */}
        <div className="mc-header">
          <svg className="mc-header-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" />
          </svg>
          <span className="mc-header-title">{t("userProfile")}</span>
          <button className="mc-header-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* User badges — above avatar for prominence */}
        {userBadges.length > 0 && (
          <div className="mc-badges-top">
            {userBadges.map((ub) => {
              const badge = ub.badge;
              if (!badge) return null;
              return <BadgePill key={ub.id} badge={badge} size="md" />;
            })}
          </div>
        )}

        {/* Avatar area */}
        <div className="mc-avatar-area">
          <div className="mc-avatar-ring">
            <Avatar
              name={member.display_name ?? member.username}
              avatarUrl={member.avatar_url}
              size={80}
              isCircle
            />
          </div>
        </div>

        {/* Body */}
        <div className="mc-body">
          {/* Name + username + join date */}
          <div className="mc-identity">
            <div className="mc-name">
              {member.display_name ?? member.username}
            </div>
            {member.display_name && (
              <div className="mc-username">@{member.username}</div>
            )}
            {member.custom_status && (
              <div className="mc-custom-status">{member.custom_status}</div>
            )}
            <div className="mc-join-date">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
              </svg>
              <span>{t("joinedAt", { date: joinDate })}</span>
            </div>
          </div>

          {/* Roles */}
          {sortedRoles.length > 0 && (
            <div className="mc-roles">
              {sortedRoles.map((role) => (
                <RoleBadge key={role.id} role={role} />
              ))}
            </div>
          )}

          {/* User Actions */}
          {!isMe && (
            <>
              <div className="mc-divider" />
              <div className="mc-section-title">{t("userActions")}</div>
              <div className="mc-actions">
                <button className="mc-btn mc-btn-primary" onClick={handleSendMessage}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z" />
                  </svg>
                  <span>{t("sendMessage")}</span>
                </button>
                <button className="mc-btn mc-btn-default" onClick={handleCall}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z" />
                  </svg>
                  <span>{t("call")}</span>
                </button>
                <button
                  className={`mc-btn${isFriend ? " mc-btn-danger" : " mc-btn-default"}`}
                  onClick={handleFriendAction}
                >
                  <FriendIcon />
                  <span>{getFriendLabel()}</span>
                </button>
                {isBadgeAdmin && (
                  <button
                    className="mc-btn mc-btn-default"
                    onClick={() => setShowBadgeAssign(true)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="8" r="7" /><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
                    </svg>
                    <span>{t("assignBadge")}</span>
                  </button>
                )}
              </div>
            </>
          )}

          {/* Badge admin action when viewing own card */}
          {isBadgeAdmin && isMe && (
            <>
              <div className="mc-divider" />
              <div className="mc-actions">
                <button
                  className="mc-btn mc-btn-default"
                  style={{ gridColumn: "1/-1" }}
                  onClick={() => setShowBadgeAssign(true)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="8" r="7" /><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88" />
                  </svg>
                  <span>{t("assignBadge")}</span>
                </button>
              </div>
            </>
          )}

          {/* Moderation */}
          {hasModActions && (
            <>
              <div className="mc-divider" />
              <div className="mc-section-title-row">
                <span className="mc-section-title">{t("moderation")}</span>
                <span className="mc-admin-tag">{t("adminAccess")}</span>
              </div>
              <div className="mc-actions">
                {canKick && (
                  <button className="mc-btn mc-btn-default" onClick={handleKick}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    <span>{t("kick")}</span>
                  </button>
                )}
                {canBan && (
                  <button className="mc-btn mc-btn-ban" onClick={handleBan}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" /><line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                    </svg>
                    <span>{t("ban")}</span>
                  </button>
                )}
                {canManageRoles && (
                  <button
                    className="mc-btn mc-btn-roles-full"
                    onClick={() => setShowRoleEditor(true)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
                    </svg>
                    <span>{t("editRoles")}</span>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* RoleEditorPopup */}
      {showRoleEditor && (
        <RoleEditorPopup
          member={member}
          position={{ top: position.top + 100, left: position.left }}
          onClose={() => setShowRoleEditor(false)}
        />
      )}

      {/* Badge Assign Modal (placeholder) */}
      {showBadgeAssign && (
        <BadgeAssignModal
          member={member}
          onClose={() => setShowBadgeAssign(false)}
        />
      )}
    </>
  );
}

export default MemberCard;
