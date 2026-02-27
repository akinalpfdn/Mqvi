/**
 * MobileMessageActions — Mobil mesaj aksiyon bottom sheet.
 *
 * Long-press ile açılır. Üstte emoji quick-react bar,
 * altta aksiyon listesi (reply, copy, pin, edit, delete).
 *
 * Aksiyonlar kullanıcı yetkilerine göre dinamik gösterilir.
 * useChatContext'ten gelen handler'ları kullanır.
 *
 * CSS: .mobile-bottom-sheet, .mobile-bs-action, .mobile-msg-emoji-bar
 */

import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import MobileBottomSheet from "../shared/MobileBottomSheet";
import type { ChatMessage } from "../../hooks/useChatContext";

type MobileMessageActionsProps = {
  isOpen: boolean;
  onClose: () => void;
  message: ChatMessage | null;
  /** Reply handler */
  onReply: () => void;
  /** Pin/unpin handler */
  onPinToggle: () => void;
  /** Edit handler — sadece message owner */
  onEdit: () => void;
  /** Delete handler — owner veya manage perms */
  onDelete: () => void;
  /** Emoji reaction handler */
  onReaction: (emoji: string) => void;
  /** Copy message content */
  onCopy: () => void;
  /** Permission: can manage messages */
  canManageMessages: boolean;
  /** Mesaj pinli mi? */
  isPinned: boolean;
};

/** Sık kullanılan emoji'ler — quick react bar */
const QUICK_EMOJIS = ["\uD83D\uDC4D", "\u2764\uFE0F", "\uD83D\uDE02", "\uD83D\uDE2E", "\uD83D\uDE22", "\uD83D\uDE4F"];

function MobileMessageActions({
  isOpen,
  onClose,
  message,
  onReply,
  onPinToggle,
  onEdit,
  onDelete,
  onReaction,
  onCopy,
  canManageMessages,
  isPinned,
}: MobileMessageActionsProps) {
  const { t } = useTranslation("chat");
  const { t: tCommon } = useTranslation("common");
  const currentUser = useAuthStore((s) => s.user);

  if (!message) return null;

  const isOwner = currentUser?.id === message.user_id;

  function handleAction(action: () => void) {
    action();
    onClose();
  }

  return (
    <MobileBottomSheet isOpen={isOpen} onClose={onClose}>
      {/* Emoji quick-react bar */}
      <div className="mobile-msg-emoji-bar">
        {QUICK_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            className="mobile-msg-emoji-btn"
            onClick={() => handleAction(() => onReaction(emoji))}
          >
            {emoji}
          </button>
        ))}
      </div>

      {/* Aksiyon listesi */}
      <div className="mobile-bs-actions-list">
        {/* Reply — her zaman */}
        <button className="mobile-bs-action" onClick={() => handleAction(onReply)}>
          <span className="mobile-bs-action-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 17 4 12 9 7" />
              <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
            </svg>
          </span>
          {t("replyMessage")}
        </button>

        {/* Copy — her zaman */}
        {message.content && (
          <button className="mobile-bs-action" onClick={() => handleAction(onCopy)}>
            <span className="mobile-bs-action-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </span>
            {t("copyMessage")}
          </button>
        )}

        {/* Pin/Unpin — canManageMessages */}
        {canManageMessages && (
          <button className="mobile-bs-action" onClick={() => handleAction(onPinToggle)}>
            <span className="mobile-bs-action-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a1 1 0 0 1 1-1h.5a.5.5 0 0 0 .5-.5v-1a.5.5 0 0 0-.5-.5h-9a.5.5 0 0 0-.5.5v1a.5.5 0 0 0 .5.5H8a1 1 0 0 1 1 1z" />
              </svg>
            </span>
            {isPinned ? t("unpinMessage") : t("pinMessage")}
          </button>
        )}

        {/* Edit — sadece owner */}
        {isOwner && (
          <button className="mobile-bs-action" onClick={() => handleAction(onEdit)}>
            <span className="mobile-bs-action-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </span>
            {t("editMessage")}
          </button>
        )}

        {/* Delete — owner veya canManageMessages */}
        {(isOwner || canManageMessages) && (
          <button className="mobile-bs-action destructive" onClick={() => handleAction(onDelete)}>
            <span className="mobile-bs-action-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </span>
            {tCommon("delete")}
          </button>
        )}
      </div>
    </MobileBottomSheet>
  );
}

export default MobileMessageActions;
