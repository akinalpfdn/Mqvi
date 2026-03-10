/** MessageHoverActions — Floating action bar shown on hover (reply, react, pin, edit, delete). */

import { useTranslation } from "react-i18next";
import EmojiPicker from "../shared/EmojiPicker";

type MessageHoverActionsProps = {
  isOwner: boolean;
  isPinned: boolean;
  canManageMessages: boolean;
  pickerSource: "bar" | "hover" | null;
  onReply: () => void;
  onReaction: (emoji: string) => void;
  onPickerOpen: () => void;
  onPickerClose: () => void;
  onPinToggle: () => void;
  onEditStart: () => void;
  onDelete: () => void;
};

function MessageHoverActions({
  isOwner,
  isPinned,
  canManageMessages,
  pickerSource,
  onReply,
  onReaction,
  onPickerOpen,
  onPickerClose,
  onPinToggle,
  onEditStart,
  onDelete,
}: MessageHoverActionsProps) {
  const { t } = useTranslation("chat");

  return (
    <div className="msg-hover-actions">
      <button onClick={onReply} title={t("replyMessage")}>
        <svg style={{ width: 14, height: 14 }} fill="currentColor" viewBox="0 0 24 24" stroke="none">
          <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" />
        </svg>
      </button>
      <div className="msg-reaction-add-wrap">
        <button onClick={onPickerOpen} title={t("addReaction")}>
          <svg style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>
        {pickerSource === "hover" && (
          <EmojiPicker
            onSelect={onReaction}
            onClose={onPickerClose}
          />
        )}
      </div>
      {canManageMessages && (
        <button onClick={onPinToggle} title={isPinned ? t("unpinMessage") : t("pinMessage")}>
          <svg style={{ width: 14, height: 14 }} fill={isPinned ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 4v4l2 2v4h-5v6l-1 1-1-1v-6H6v-4l2-2V4a1 1 0 011-1h6a1 1 0 011 1z" />
          </svg>
        </button>
      )}
      {isOwner && (
        <button onClick={onEditStart} title={t("editMessage")}>
          <svg style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
      )}
      {(isOwner || canManageMessages) && (
        <button onClick={onDelete} title={t("deleteMessage")}>
          <svg style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default MessageHoverActions;
