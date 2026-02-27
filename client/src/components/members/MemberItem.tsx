/**
 * MemberItem — Üye listesinde tek bir kullanıcı satırı.
 *
 * CSS class'ları: .member, .member.offline, .member-av-wrap,
 * .member-status, .status-on, .status-idle, .status-dnd, .status-off,
 * .member-info, .member-name, .member-activity
 *
 * MemberCard popup: React Portal ile body seviyesinde render edilir.
 *
 * Sağ tık context menu aksiyonları:
 * - Send Message (DM)
 * - Call (P2P audio)
 * - Add Friend / Cancel Request / Accept Request / Remove Friend
 * - Copy ID
 * - Edit Roles (ManageRoles yetkisi)
 * - Kick / Ban (yetki + hiyerarşi)
 */

import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import Avatar from "../shared/Avatar";
import ContextMenu from "../shared/ContextMenu";
import { useContextMenu } from "../../hooks/useContextMenu";
import type { ContextMenuItem } from "../../hooks/useContextMenu";
import { useAuthStore } from "../../stores/authStore";
import { useMemberStore } from "../../stores/memberStore";
import { useDMStore } from "../../stores/dmStore";
import { useUIStore } from "../../stores/uiStore";
import { useFriendStore } from "../../stores/friendStore";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useConfirm } from "../../hooks/useConfirm";
import { hasPermission, Permissions } from "../../utils/permissions";
import * as memberApi from "../../api/members";
import type { MemberWithRoles } from "../../types";
import MemberCard from "./MemberCard";
import RoleEditorPopup from "./RoleEditorPopup";

type MemberItemProps = {
  member: MemberWithRoles;
  isOnline: boolean;
};

function getHighestRole(member: MemberWithRoles) {
  if (member.roles.length === 0) return null;
  return member.roles.reduce((highest, role) =>
    role.position > highest.position ? role : highest
  );
}

function getRoleType(member: MemberWithRoles): "admin" | "mod" | null {
  const highest = getHighestRole(member);
  if (!highest) return null;

  const name = highest.name.toLowerCase();
  if (name.includes("admin") || name.includes("owner")) return "admin";
  if (name.includes("mod")) return "mod";
  return null;
}

function getStatusClass(status: string): string {
  switch (status) {
    case "online":
      return "status-on";
    case "idle":
      return "status-idle";
    case "dnd":
      return "status-dnd";
    default:
      return "status-off";
  }
}

function MemberItem({ member, isOnline }: MemberItemProps) {
  const { t } = useTranslation("common");
  const { menuState, openMenu, closeMenu } = useContextMenu();
  const confirm = useConfirm();
  const currentUser = useAuthStore((s) => s.user);
  const members = useMemberStore((s) => s.members);
  const friends = useFriendStore((s) => s.friends);
  const incoming = useFriendStore((s) => s.incoming);
  const outgoing = useFriendStore((s) => s.outgoing);

  const [showCard, setShowCard] = useState(false);
  const [cardPos, setCardPos] = useState({ top: 0, left: 0 });
  const [showRoleEditor, setShowRoleEditor] = useState(false);
  const [roleEditorPos, setRoleEditorPos] = useState({ top: 0, left: 0 });
  const itemRef = useRef<HTMLDivElement>(null);
  const highestRole = getHighestRole(member);
  const roleType = getRoleType(member);

  const nameColor = highestRole?.color || undefined;
  const displayName = member.display_name ?? member.username;

  /** Sağ tık context menu — üye aksiyonları */
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const isSelf = currentUser?.id === member.id;
      const currentMember = members.find((m) => m.id === currentUser?.id);
      const myPerms = currentMember?.effective_permissions ?? 0;
      const canKick = hasPermission(myPerms, Permissions.KickMembers);
      const canBan = hasPermission(myPerms, Permissions.BanMembers);
      const canManageRoles = hasPermission(myPerms, Permissions.ManageRoles);

      const items: ContextMenuItem[] = [];

      // ─── Send Message (DM) — kendine mesaj atma yok ───
      if (!isSelf) {
        items.push({
          label: t("sendMessage"),
          onClick: async () => {
            const channelId = await useDMStore.getState().createOrGetChannel(member.id);
            if (channelId) {
              useDMStore.getState().selectDM(channelId);
              useUIStore.getState().openTab(channelId, "dm", member.display_name ?? member.username);
            }
          },
        });
      }

      // ─── Call (P2P audio) ───
      if (!isSelf) {
        items.push({
          label: t("call"),
          onClick: async () => {
            // DM kanalı oluştur/al, sonra arama başlat
            const channelId = await useDMStore.getState().createOrGetChannel(member.id);
            if (channelId) {
              useDMStore.getState().selectDM(channelId);
              useUIStore.getState().openTab(channelId, "dm", member.display_name ?? member.username);
            }
            useP2PCallStore.getState().initiateCall(member.id, "voice");
          },
        });
      }

      // ─── Friend action — duruma göre dinamik ───
      if (!isSelf) {
        const isFriend = friends.some((f) => f.user_id === member.id);
        const outReq = outgoing.find((r) => r.user_id === member.id);
        const inReq = incoming.find((r) => r.user_id === member.id);

        if (isFriend) {
          items.push({
            label: t("removeFriend"),
            onClick: async () => {
              const ok = await confirm({
                message: t("confirmRemoveFriend", { username: member.username }),
                confirmLabel: t("removeFriend"),
                danger: true,
              });
              if (ok) await useFriendStore.getState().removeFriend(member.id);
            },
            danger: true,
          });
        } else if (outReq) {
          items.push({
            label: t("cancelRequest"),
            onClick: async () => {
              await useFriendStore.getState().declineRequest(outReq.id);
            },
          });
        } else if (inReq) {
          items.push({
            label: t("acceptRequest"),
            onClick: async () => {
              await useFriendStore.getState().acceptRequest(inReq.id);
            },
          });
        } else {
          items.push({
            label: t("addFriend"),
            onClick: async () => {
              await useFriendStore.getState().sendRequest(member.username);
            },
          });
        }
      }

      // ─── Copy ID ───
      items.push({
        label: "Copy ID",
        onClick: () => navigator.clipboard.writeText(member.id),
        separator: !isSelf,
      });

      // ─── Edit Roles — ManageRoles yetkisi, kendine yapılamaz ───
      if (canManageRoles && !isSelf) {
        items.push({
          label: t("editRoles"),
          onClick: () => {
            setRoleEditorPos({ top: e.clientY, left: e.clientX });
            setShowRoleEditor(true);
          },
          separator: true,
        });
      }

      // ─── Kick ───
      if (canKick && !isSelf) {
        items.push({
          label: t("kick"),
          onClick: async () => {
            const ok = await confirm({
              message: t("confirmKick", { username: member.username }),
              confirmLabel: t("kick"),
              danger: true,
            });
            if (ok) await memberApi.kickMember(member.id);
          },
          danger: true,
          separator: !canManageRoles,
        });
      }

      // ─── Ban ───
      if (canBan && !isSelf) {
        items.push({
          label: t("ban"),
          onClick: async () => {
            const ok = await confirm({
              message: t("confirmBan", { username: member.username }),
              confirmLabel: t("ban"),
              danger: true,
            });
            if (ok) await memberApi.banMember(member.id, "");
          },
          danger: true,
        });
      }

      openMenu(e, items);
    },
    [currentUser, member, members, friends, incoming, outgoing, openMenu, confirm, t]
  );

  const handleClick = useCallback(() => {
    if (showCard) {
      setShowCard(false);
      return;
    }

    if (itemRef.current) {
      const rect = itemRef.current.getBoundingClientRect();
      const cardWidth = 288;
      const gap = 8;

      let top = rect.top;
      const cardEstimatedHeight = 350;
      if (top + cardEstimatedHeight > window.innerHeight) {
        top = window.innerHeight - cardEstimatedHeight - 16;
      }
      if (top < 8) top = 8;

      setCardPos({
        top,
        left: rect.left - cardWidth - gap,
      });
    }

    setShowCard(true);
  }, [showCard]);

  return (
    <>
      <div
        ref={itemRef}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        className={`member${!isOnline ? " offline" : ""}`}
      >
        {/* Avatar + status dot */}
        <div className="member-av-wrap">
          <Avatar
            name={member.username}
            role={roleType}
            avatarUrl={member.avatar_url ?? undefined}
            size={32}
          />
          <span className={`member-status ${getStatusClass(member.status)}`} />
        </div>

        {/* Name + Activity */}
        <div className="member-info">
          <span
            className="member-name"
            style={nameColor ? { color: nameColor } : undefined}
          >
            {displayName}
          </span>

          {member.custom_status && (
            <span className="member-activity">
              {member.custom_status}
            </span>
          )}
        </div>
      </div>

      {/* Context Menu — sağ tık ile açılır */}
      <ContextMenu state={menuState} onClose={closeMenu} />

      {/* MemberCard — Portal ile body'ye render edilir */}
      {showCard &&
        createPortal(
          <MemberCard
            member={member}
            position={cardPos}
            onClose={() => setShowCard(false)}
          />,
          document.body
        )}

      {/* RoleEditorPopup — rol düzenleme popup'ı */}
      {showRoleEditor && (
        <RoleEditorPopup
          member={member}
          position={roleEditorPos}
          onClose={() => setShowRoleEditor(false)}
        />
      )}
    </>
  );
}

export default MemberItem;
