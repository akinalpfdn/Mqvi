/**
 * Message — Tek bir mesajı render eden component.
 *
 * CSS class'ları: .msg, .msg.first-of-group, .msg.grouped,
 * .msg-row, .msg-avatar, .msg-body, .msg-meta, .msg-name,
 * .name-admin, .name-mod, .name-default, .msg-time, .msg-text,
 * .msg-edited, .msg-gtime, .msg-hover-actions,
 * .msg-edit-area, .msg-edit-textarea, .msg-edit-hint,
 * .msg-attachments, .msg-attachment-img, .msg-attachment-file
 *
 * Hover efektleri tamamen CSS ile yönetilir:
 * - .msg:hover .msg-hover-actions { opacity:1 }
 * - .msg.grouped:hover .msg-gtime { opacity:1 }
 */

import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useMessageStore } from "../../stores/messageStore";
import { useMemberStore } from "../../stores/memberStore";
import { usePinStore } from "../../stores/pinStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import { useContextMenu } from "../../hooks/useContextMenu";
import type { ContextMenuItem } from "../../hooks/useContextMenu";
import Avatar from "../shared/Avatar";
import ContextMenu from "../shared/ContextMenu";
import type { Message as MessageType, MemberWithRoles } from "../../types";

type MessageProps = {
  message: MessageType;
  /** Aynı yazarın ardışık mesajı mı? (compact mode için) */
  isCompact: boolean;
};

/**
 * getRoleType — Üyenin en yüksek pozisyonlu rolünü alıp Avatar'a uygun
 * role tipini döner.
 */
function getRoleType(member: MemberWithRoles | undefined): "admin" | "mod" | null {
  if (!member || member.roles.length === 0) return null;

  const highest = member.roles.reduce((h, r) =>
    r.position > h.position ? r : h
  );

  const name = highest.name.toLowerCase();
  if (name.includes("admin") || name.includes("owner")) return "admin";
  if (name.includes("mod")) return "mod";
  return null;
}

/**
 * getNameClass — Role'a göre CSS class döner.
 * admin → "name-admin", mod → "name-mod", diğer → "name-default"
 */
function getNameClass(roleType: "admin" | "mod" | null): string {
  switch (roleType) {
    case "admin":
      return "name-admin";
    case "mod":
      return "name-mod";
    default:
      return "name-default";
  }
}

function Message({ message, isCompact }: MessageProps) {
  const { t } = useTranslation("chat");
  const currentUser = useAuthStore((s) => s.user);
  const editMessage = useMessageStore((s) => s.editMessage);
  const deleteMessage = useMessageStore((s) => s.deleteMessage);
  const members = useMemberStore((s) => s.members);

  const pinAction = usePinStore((s) => s.pin);
  const unpinAction = usePinStore((s) => s.unpin);
  const isMessagePinned = usePinStore((s) => s.isMessagePinned);

  const { menuState, openMenu, closeMenu } = useContextMenu();
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content ?? "");

  const isOwner = currentUser?.id === message.user_id;
  const member = members.find((m) => m.id === message.user_id);
  const roleType = getRoleType(member);

  // Mevcut kullanıcının yetkilerini hesapla (pin butonu gösterimi için)
  const currentMember = members.find((m) => m.id === currentUser?.id);
  const canManageMessages = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.ManageMessages)
    : false;
  const isPinned = isMessagePinned(message.channel_id, message.id);

  /** Timestamp formatı: HH:MM */
  const formatTime = useCallback((dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }, []);

  /** Tam tarih formatı: DD/MM/YYYY HH:MM */
  const formatFullDate = useCallback((dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString([], {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }, []);

  /** Edit kaydetme — Enter ile */
  async function handleEditSave() {
    if (editContent.trim() && editContent.trim() !== message.content) {
      await editMessage(message.id, editContent.trim());
    }
    setIsEditing(false);
  }

  /** Edit iptal — Escape ile */
  function handleEditCancel() {
    setEditContent(message.content ?? "");
    setIsEditing(false);
  }

  /** Mesaj silme */
  async function handleDelete() {
    await deleteMessage(message.id);
  }

  /** Pin/Unpin toggle */
  async function handlePinToggle() {
    if (isPinned) {
      await unpinAction(message.channel_id, message.id);
    } else {
      await pinAction(message.channel_id, message.id);
    }
  }

  /** Sağ tık context menu — mesaj aksiyonları */
  function handleContextMenu(e: React.MouseEvent) {
    const items: ContextMenuItem[] = [];

    // Copy Message — herkes
    items.push({
      label: t("copyMessage"),
      onClick: () => {
        if (message.content) navigator.clipboard.writeText(message.content);
      },
    });

    // Pin/Unpin — ManageMessages yetkisi
    if (canManageMessages) {
      items.push({
        label: isPinned ? t("unpinMessage") : t("pinMessage"),
        onClick: handlePinToggle,
        separator: true,
      });
    }

    // Edit — sadece mesaj sahibi
    if (isOwner) {
      items.push({
        label: t("editMessage"),
        onClick: () => {
          setEditContent(message.content ?? "");
          setIsEditing(true);
        },
        separator: !canManageMessages,
      });
    }

    // Delete — mesaj sahibi VEYA ManageMessages
    if (isOwner || canManageMessages) {
      items.push({
        label: t("deleteMessage"),
        onClick: handleDelete,
        danger: true,
      });
    }

    // Copy ID — herkes (debug/gelişmiş kullanım)
    items.push({
      label: t("copyId"),
      onClick: () => navigator.clipboard.writeText(message.id),
      separator: true,
    });

    openMenu(e, items);
  }

  const displayName =
    message.author?.display_name ?? message.author?.username ?? "Unknown";

  /**
   * renderContent — Mesaj içeriğindeki @username kalıplarını highlight ile render eder.
   *
   * Regex ile @username'leri bulur ve <span className="msg-mention"> ile sarar.
   * Mention olmayan kısımlar düz metin olarak kalır.
   * React.Fragment (key ile) kullanılır — her parça benzersiz key alır.
   */
  function renderContent(text: string | null): React.ReactNode {
    if (!text) return null;

    // @kelime_karakterleri pattern'ini parçala
    const parts = text.split(/(@\w+)/g);
    return parts.map((part, i) => {
      if (/^@\w+$/.test(part)) {
        return (
          <span key={i} className="msg-mention">
            {part}
          </span>
        );
      }
      return part;
    });
  }

  const msgClass = `msg${!isCompact ? " first-of-group" : " grouped"}`;

  return (
    <div className={msgClass} onContextMenu={handleContextMenu}>
      {/* Compact timestamp — grouped mesajlarda hover ile görünür (CSS) */}
      <span className="msg-gtime">{formatTime(message.created_at)}</span>

      <div className="msg-row">
        {/* Avatar — grouped mesajlarda CSS ile gizlenir (visibility:hidden) */}
        <div className="msg-avatar">
          <Avatar
            name={displayName}
            role={roleType}
            avatarUrl={message.author?.avatar_url ?? undefined}
            size={30}
          />
        </div>

        {/* Mesaj içeriği */}
        <div className="msg-body">
          {/* Username + timestamp — grouped mesajlarda CSS ile gizlenir (display:none) */}
          <div className="msg-meta">
            <span className={`msg-name ${getNameClass(roleType)}`}>
              {displayName}
            </span>
            <span
              className="msg-time"
              title={formatFullDate(message.created_at)}
            >
              {formatTime(message.created_at)}
            </span>
          </div>

          {/* Pin indicator — mesaj pinliyse küçük pin ikonu göster */}
          {isPinned && (
            <div className="msg-pin-indicator">
              <svg style={{ width: 12, height: 12 }} fill="currentColor" viewBox="0 0 24 24" stroke="none">
                <path d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
              </svg>
              <span>{t("pinnedMessages")}</span>
            </div>
          )}

          {/* Content */}
          {isEditing ? (
            <div className="msg-edit-area">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleEditSave();
                  }
                  if (e.key === "Escape") handleEditCancel();
                }}
                className="msg-edit-textarea"
                rows={2}
                autoFocus
              />
              <p className="msg-edit-hint">
                escape = {t("editCancel", "cancel")}, enter = {t("editSave", "save")}
              </p>
            </div>
          ) : (
            <div className="msg-text">
              {renderContent(message.content)}
              {message.edited_at && (
                <span className="msg-edited">
                  {t("edited")}
                </span>
              )}
            </div>
          )}

          {/* Attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="msg-attachments">
              {message.attachments.map((attachment) => {
                const isImage = attachment.mime_type?.startsWith("image/");

                if (isImage) {
                  return (
                    <a
                      key={attachment.id}
                      href={attachment.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <img
                        src={attachment.file_url}
                        alt={attachment.filename}
                        className="msg-attachment-img"
                        loading="lazy"
                      />
                    </a>
                  );
                }

                return (
                  <a
                    key={attachment.id}
                    href={attachment.file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="msg-attachment-file"
                  >
                    <svg
                      className="msg-attachment-file-icon"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                      />
                    </svg>
                    <div style={{ minWidth: 0 }}>
                      <p className="msg-attachment-file-name">
                        {attachment.filename}
                      </p>
                      {attachment.file_size && (
                        <p className="msg-attachment-file-size">
                          {formatFileSize(attachment.file_size)}
                        </p>
                      )}
                    </div>
                  </a>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Hover actions (edit/delete/pin) — CSS ile hover'da görünür */}
      {/* Context Menu — sağ tık ile açılır */}
      <ContextMenu state={menuState} onClose={closeMenu} />

      {(isOwner || canManageMessages) && !isEditing && (
        <div className="msg-hover-actions">
          {/* Pin/Unpin — ManageMessages yetkisi gerekir */}
          {canManageMessages && (
            <button
              onClick={handlePinToggle}
              title={isPinned ? t("unpinMessage") : t("pinMessage")}
            >
              <svg style={{ width: 14, height: 14 }} fill={isPinned ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
              </svg>
            </button>
          )}
          {/* Edit — sadece mesaj sahibi */}
          {isOwner && (
            <button
              onClick={() => {
                setEditContent(message.content ?? "");
                setIsEditing(true);
              }}
              title={t("editMessage")}
            >
              <svg style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
          {/* Delete — mesaj sahibi VEYA ManageMessages */}
          {(isOwner || canManageMessages) && (
            <button
              onClick={handleDelete}
              title={t("deleteMessage")}
            >
              <svg style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Dosya boyutunu okunabilir formata çevirir (1024 → "1.0 KB") */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default Message;
