/**
 * Message — Tek bir mesajı render eden component.
 *
 * İki görünüm modu var:
 * 1. Normal: Avatar + username + timestamp + content + attachments
 * 2. Compact: Sadece content (aynı yazar 5 dakika içinde yazdıysa)
 *
 * Hover'da edit/delete action'ları görünür.
 * Edit mode'da inline textarea açılır.
 */

import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useMessageStore } from "../../stores/messageStore";
import type { Message as MessageType } from "../../types";

type MessageProps = {
  message: MessageType;
  /** Aynı yazarın ardışık mesajı mı? (compact mode için) */
  isCompact: boolean;
};

function Message({ message, isCompact }: MessageProps) {
  const { t } = useTranslation("chat");
  const currentUser = useAuthStore((s) => s.user);
  const editMessage = useMessageStore((s) => s.editMessage);
  const deleteMessage = useMessageStore((s) => s.deleteMessage);

  const [isHovered, setIsHovered] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content ?? "");

  const isOwner = currentUser?.id === message.user_id;

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

  return (
    <div
      className={`group relative flex px-4 py-0.5 hover:bg-background-secondary/30 ${
        !isCompact ? "mt-4" : ""
      }`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Avatar veya boşluk (compact mode) */}
      <div className="mr-4 w-10 shrink-0">
        {!isCompact && (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
            {message.author?.username?.charAt(0).toUpperCase() ?? "?"}
          </div>
        )}
        {isCompact && isHovered && (
          <span className="text-[11px] text-text-muted">
            {formatTime(message.created_at)}
          </span>
        )}
      </div>

      {/* Mesaj içeriği */}
      <div className="min-w-0 flex-1">
        {/* Username + timestamp (sadece normal mode) */}
        {!isCompact && (
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-medium text-text-primary hover:underline">
              {message.author?.display_name ?? message.author?.username ?? "Unknown"}
            </span>
            <span className="text-xs text-text-muted" title={formatFullDate(message.created_at)}>
              {formatFullDate(message.created_at)}
            </span>
          </div>
        )}

        {/* Content */}
        {isEditing ? (
          <div className="mt-1">
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
              className="w-full resize-none rounded-md bg-input p-2 text-[15px] text-text-primary outline-none"
              rows={2}
              autoFocus
            />
            <p className="mt-1 text-xs text-text-muted">
              escape = cancel, enter = save
            </p>
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.375rem] text-text-primary">
            {message.content}
            {message.edited_at && (
              <span className="ml-1 text-xs text-text-muted">{t("edited")}</span>
            )}
          </p>
        )}

        {/* Attachments */}
        {message.attachments && message.attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {message.attachments.map((attachment) => {
              const isImage = attachment.mime_type?.startsWith("image/");

              if (isImage) {
                return (
                  <a
                    key={attachment.id}
                    href={attachment.file_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block max-w-md overflow-hidden rounded-md"
                  >
                    <img
                      src={attachment.file_url}
                      alt={attachment.filename}
                      className="max-h-[300px] rounded-md object-contain"
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
                  className="flex items-center gap-2 rounded-md bg-background-secondary p-3 transition-colors hover:bg-surface-hover"
                >
                  <svg
                    className="h-8 w-8 shrink-0 text-text-muted"
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
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-brand hover:underline">
                      {attachment.filename}
                    </p>
                    {attachment.file_size && (
                      <p className="text-xs text-text-muted">
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

      {/* Hover actions (edit/delete) */}
      {isHovered && !isEditing && (
        <div className="absolute -top-3 right-4 flex rounded-md border border-background-tertiary bg-background-secondary shadow-sm">
          {isOwner && (
            <button
              onClick={() => {
                setEditContent(message.content ?? "");
                setIsEditing(true);
              }}
              title={t("editMessage")}
              className="flex h-8 w-8 items-center justify-center text-text-muted transition-colors hover:text-text-primary"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
          {isOwner && (
            <button
              onClick={handleDelete}
              title={t("deleteMessage")}
              className="flex h-8 w-8 items-center justify-center text-text-muted transition-colors hover:text-danger"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
