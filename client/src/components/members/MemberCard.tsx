/**
 * MemberCard — Üye profil popover'ı.
 *
 * Bir üyeye tıklandığında açılan kart:
 * - Büyük avatar + status indicator
 * - Username + display name
 * - Roller (badge olarak)
 * - Katılım tarihi
 * - Aksiyonlar (Manage Roles, Kick, Ban) — yetkiye göre gösterilir
 *
 * Pozisyon: MemberItem'ın solunda overlay olarak gösterilir.
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
  /** Portal ile body'ye render edildiğinde card'ın ekran pozisyonu */
  position: { top: number; left: number };
  onClose: () => void;
};

function MemberCard({ member, position, onClose }: MemberCardProps) {
  const { t } = useTranslation("common");
  const cardRef = useRef<HTMLDivElement>(null);
  const currentUser = useAuthStore((s) => s.user);

  // Mevcut kullanıcının effective permission'larını hesapla
  const currentMember = useMemberStore((s) =>
    s.members.find((m) => m.id === currentUser?.id)
  );
  const myPerms = currentMember?.effective_permissions ?? 0;

  const isMe = currentUser?.id === member.id;
  const canKick = !isMe && hasPermission(myPerms, Permissions.KickMembers);
  const canBan = !isMe && hasPermission(myPerms, Permissions.BanMembers);
  const canManageRoles =
    !isMe && hasPermission(myPerms, Permissions.ManageRoles);

  // Dışarıya tıklandığında kapatma.
  // requestAnimationFrame ile bir frame bekleriz — aksi halde
  // MemberItem'daki click eventi henüz bitmeden mousedown listener
  // hemen tetiklenir ve card açılır açılmaz kapanır.
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

  // Rolleri position DESC sıralı göster
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
    <div
      ref={cardRef}
      className="fixed z-50 w-72 rounded-lg bg-background-floating shadow-xl"
      style={{ top: position.top, left: position.left }}
    >
      {/* Banner (renk şeridi) */}
      <div
        className="h-16 rounded-t-lg"
        style={{
          backgroundColor:
            sortedRoles[0]?.color || "var(--color-brand)",
        }}
      />

      {/* Avatar + Bilgiler */}
      <div className="relative px-4 pb-4">
        {/* Büyük avatar */}
        <div className="-mt-8 mb-3">
          <div className="flex h-16 w-16 items-center justify-center rounded-full border-4 border-background-floating bg-brand text-xl font-bold text-white">
            {member.username.charAt(0).toUpperCase()}
          </div>
        </div>

        {/* Username */}
        <h3 className="text-lg font-bold text-text-primary">
          {member.display_name ?? member.username}
        </h3>
        {member.display_name && (
          <p className="text-sm text-text-muted">{member.username}</p>
        )}

        {/* Custom status */}
        {member.custom_status && (
          <p className="mt-1 text-sm text-text-secondary">
            {member.custom_status}
          </p>
        )}

        {/* Divider */}
        <div className="my-3 border-t border-background-tertiary" />

        {/* Roller */}
        <div className="mb-3">
          <h4 className="mb-2 text-xs font-bold uppercase text-text-muted">
            {t("roles")}
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {sortedRoles.length > 0 ? (
              sortedRoles.map((role) => (
                <RoleBadge key={role.id} role={role} />
              ))
            ) : (
              <span className="text-xs text-text-muted">{t("noRoles")}</span>
            )}
          </div>
        </div>

        {/* Katılım tarihi */}
        <p className="text-xs text-text-muted">
          {t("joinedAt", { date: joinDate })}
        </p>

        {/* Aksiyonlar */}
        {(canManageRoles || canKick || canBan) && (
          <div className="mt-3 flex gap-2">
            {canKick && (
              <button
                onClick={handleKick}
                className="rounded-md bg-surface px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover"
              >
                {t("kick")}
              </button>
            )}
            {canBan && (
              <button
                onClick={handleBan}
                className="rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-80"
              >
                {t("ban")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default MemberCard;
