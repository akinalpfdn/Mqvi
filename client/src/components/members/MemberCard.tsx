/**
 * MemberCard — Üye profil popover'ı.
 *
 * CSS class'ları: .member-card-backdrop, .member-card, .member-card-banner,
 * .member-card-avatar, .member-card-body, .member-card-name,
 * .member-card-username, .member-card-divider, .member-card-section-title,
 * .member-card-roles, .member-card-joined, .member-card-actions,
 * .member-card-btn, .member-card-btn-kick, .member-card-btn-ban
 *
 * Pozisyon: MemberItem'ın solunda portal ile gösterilir.
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { MemberWithRoles } from "../../types";
import RoleBadge from "./RoleBadge";
import { useAuthStore } from "../../stores/authStore";
import { useMemberStore } from "../../stores/memberStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as memberApi from "../../api/members";

type MemberCardProps = {
  member: MemberWithRoles;
  position: { top: number; left: number };
  onClose: () => void;
};

function MemberCard({ member, position, onClose }: MemberCardProps) {
  const { t } = useTranslation("common");
  const cardRef = useRef<HTMLDivElement>(null);
  const currentUser = useAuthStore((s) => s.user);

  const currentMember = useMemberStore((s) =>
    s.members.find((m) => m.id === currentUser?.id)
  );
  const myPerms = currentMember?.effective_permissions ?? 0;

  const isMe = currentUser?.id === member.id;
  const canKick = !isMe && hasPermission(myPerms, Permissions.KickMembers);
  const canBan = !isMe && hasPermission(myPerms, Permissions.BanMembers);
  const canManageRoles =
    !isMe && hasPermission(myPerms, Permissions.ManageRoles);

  useEffect(() => {
    let frameId: number;

    function handleClick(e: MouseEvent) {
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
    if (!confirm(t("confirmKick", { username: member.username }))) return;
    await memberApi.kickMember(member.id);
    onClose();
  }

  async function handleBan() {
    const reason = prompt(t("banReason")) ?? "";
    if (!confirm(t("confirmBan", { username: member.username }))) return;
    await memberApi.banMember(member.id, reason);
    onClose();
  }

  return (
    <>
      {/* Backdrop — dışarıya tıklamayı yakalamak için */}
      <div className="member-card-backdrop" onClick={onClose} />

      <div
        ref={cardRef}
        className="member-card"
        style={{ top: position.top, left: position.left }}
      >
        {/* Banner */}
        <div
          className="member-card-banner"
          style={
            sortedRoles[0]?.color
              ? { background: `linear-gradient(135deg, ${sortedRoles[0].color}, #a06840)` }
              : undefined
          }
        />

        {/* Avatar */}
        <div className="member-card-avatar">
          <div
            className="avatar av-default avatar-round"
            style={{ width: 64, height: 64, fontSize: 24 }}
          >
            {member.username.charAt(0).toUpperCase()}
          </div>
        </div>

        {/* Body */}
        <div className="member-card-body">
          <div className="member-card-name">
            {member.display_name ?? member.username}
          </div>
          {member.display_name && (
            <div className="member-card-username">{member.username}</div>
          )}

          {member.custom_status && (
            <div className="member-card-username" style={{ marginTop: 4 }}>
              {member.custom_status}
            </div>
          )}

          <div className="member-card-divider" />

          {/* Roles */}
          <div className="member-card-section-title">{t("roles")}</div>
          <div className="member-card-roles">
            {sortedRoles.length > 0 ? (
              sortedRoles.map((role) => (
                <RoleBadge key={role.id} role={role} />
              ))
            ) : (
              <span className="member-card-joined">{t("noRoles")}</span>
            )}
          </div>

          <div className="member-card-divider" />

          {/* Join date */}
          <div className="member-card-joined">
            {t("joinedAt", { date: joinDate })}
          </div>

          {/* Actions */}
          {(canManageRoles || canKick || canBan) && (
            <div className="member-card-actions">
              {canKick && (
                <button
                  className="member-card-btn member-card-btn-kick"
                  onClick={handleKick}
                >
                  {t("kick")}
                </button>
              )}
              {canBan && (
                <button
                  className="member-card-btn member-card-btn-ban"
                  onClick={handleBan}
                >
                  {t("ban")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default MemberCard;
