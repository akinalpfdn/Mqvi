/** ReplyBar — Reply preview bar shown above input. */

import { useTranslation } from "react-i18next";
import type { ChatMessage } from "../../hooks/useChatContext";

type ReplyBarProps = {
  message: ChatMessage;
  onCancel: () => void;
};

function ReplyBar({ message, onCancel }: ReplyBarProps) {
  const { t } = useTranslation("chat");

  const authorName =
    message.author?.display_name ?? message.author?.username ?? t("unknownUser");

  /** Content preview — shows "noContent" for file-only messages */
  const previewText = message.content ?? t("noContent");

  return (
    <div className="reply-bar">
      {/* Reply arrow icon */}
      <svg
        className="reply-bar-icon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
      >
        <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" />
      </svg>

      <span className="reply-bar-user">
        {t("replyingTo", { user: authorName })}
      </span>

      <span className="reply-bar-text">{previewText}</span>

      {/* Cancel button */}
      <button className="reply-bar-close" onClick={onCancel} title="Escape">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
      </button>
    </div>
  );
}

export default ReplyBar;
