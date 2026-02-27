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

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemberWithRoles } from "../../types";
import Avatar from "../shared/Avatar";
import RoleBadge from "./RoleBadge";
import RoleEditorPopup from "./RoleEditorPopup";
import { useAuthStore } from "../../stores/authStore";
import { useMemberStore } from "../../stores/memberStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { useFriendStore } from "../../stores/friendStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useConfirm } from "../../hooks/useConfirm";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as memberApi from "../../api/members";

type MemberCardProps = {
  member: MemberWithRoles;
  position: { top: number; left: number };
  onClose: () => void;
};

function MemberCard({ member, position, onClose }: MemberCardProps) {
  const { t } = useTranslation("common");
  const confirm = useConfirm();
  const cardRef = useRef<HTMLDivElement>(null);
  const currentUser = useAuthStore((s) => s.user);

  const currentMember = useMemberStore((s) =>
    s.members.find((m) => m.id === currentUser?.id)
  );
  const myPerms = currentMember?.effective_permissions ?? 0;

  const friends = useFriendStore((s) => s.friends);
  const incoming = useFriendStore((s) => s.incoming);
  const outgoing = useFriendStore((s) => s.outgoing);

  const [showRoleEditor, setShowRoleEditor] = useState(false);

  const isMe = currentUser?.id === member.id;
  const canKick = !isMe && hasPermission(myPerms, Permissions.KickMembers);
  const canBan = !isMe && hasPermission(myPerms, Permissions.BanMembers);
  const canManageRoles = !isMe && hasPermission(myPerms, Permissions.ManageRoles);

  // Arkadaşlık durumu
  const isFriend = friends.some((f) => f.user_id === member.id);
  const outReq = outgoing.find((r) => r.user_id === member.id);
  const inReq = incoming.find((r) => r.user_id === member.id);

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
    const ok = await confirm({
      message: t("confirmKick", { username: member.username }),
      confirmLabel: t("kick"),
      danger: true,
    });
    if (!ok) return;
    await memberApi.kickMember(member.id);
    onClose();
  }

  async function handleBan() {
    const ok = await confirm({
      message: t("confirmBan", { username: member.username }),
      confirmLabel: t("ban"),
      danger: true,
    });
    if (!ok) return;
    await memberApi.banMember(member.id, "");
    onClose();
  }

  /**
   * handleSendMessage — DM kanalı oluşturur/alır ve tab olarak açar.
   * createOrGetChannel: Kanal yoksa oluşturur, varsa mevcut olanı döner.
   * openTab: DM tab'ını panelde açar (type: "dm").
   */
  async function handleSendMessage() {
    const channelId = await useDMStore.getState().createOrGetChannel(member.id);
    if (channelId) {
      const displayName = member.display_name ?? member.username;
      useUIStore.getState().openTab(channelId, "dm", displayName);
    }
    onClose();
  }

  /**
   * handleCall — DM kanalı açar ve P2P sesli arama başlatır.
   * initiateCall: WebRTC signaling başlatır, karşı tarafa offer gönderir.
   */
  async function handleCall() {
    const channelId = await useDMStore.getState().createOrGetChannel(member.id);
    if (channelId) {
      const displayName = member.display_name ?? member.username;
      useDMStore.getState().selectDM(channelId);
      useUIStore.getState().openTab(channelId, "dm", displayName);
    }
    useP2PCallStore.getState().initiateCall(member.id, "audio");
    onClose();
  }

  /**
   * handleFriendAction — Arkadaşlık durumuna göre uygun aksiyonu çalıştırır.
   * isFriend → removeFriend (onay ile), outReq → cancelRequest, inReq → acceptRequest,
   * hiçbiri değilse → sendRequest (arkadaş ekle).
   */
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

  /** friendLabel — Arkadaşlık durumuna göre buton metni */
  function getFriendLabel(): string {
    if (isFriend) return t("removeFriend");
    if (outReq) return t("cancelRequest");
    if (inReq) return t("acceptRequest");
    return t("addFriend");
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
              ? { background: `linear-gradient(135deg, ${sortedRoles[0].color}, var(--secondary))` }
              : undefined
          }
        />

        {/* Avatar */}
        <div className="member-card-avatar">
          <Avatar
            name={member.display_name ?? member.username}
            avatarUrl={member.avatar_url}
            size={64}
            isCircle
          />
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
          <div className="member-card-actions">
            {!isMe && (
              <button
                className="member-card-btn member-card-btn-dm"
                onClick={handleSendMessage}
              >
                {t("sendMessage")}
              </button>
            )}
            {!isMe && (
              <button
                className="member-card-btn member-card-btn-call"
                onClick={handleCall}
              >
                {t("call")}
              </button>
            )}
            {!isMe && (
              <button
                className={`member-card-btn${isFriend ? " member-card-btn-danger" : ""}`}
                onClick={handleFriendAction}
              >
                {getFriendLabel()}
              </button>
            )}
            {canManageRoles && (
              <button
                className="member-card-btn"
                onClick={() => setShowRoleEditor(true)}
              >
                {t("editRoles")}
              </button>
            )}
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
        </div>
      </div>

      {/* RoleEditorPopup — rol düzenleme popup'ı */}
      {showRoleEditor && (
        <RoleEditorPopup
          member={member}
          position={{ top: position.top + 100, left: position.left }}
          onClose={() => setShowRoleEditor(false)}
        />
      )}
    </>
  );
}

export default MemberCard;
