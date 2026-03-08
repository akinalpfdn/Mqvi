/** TypingIndicator — "X is typing..." display. Works in both channel and DM via ChatContext. */

import { useTranslation } from "react-i18next";
import { useChatContext } from "../../hooks/useChatContext";

function TypingIndicator() {
  const { t } = useTranslation("chat");
  const { typingUsers } = useChatContext();

  if (typingUsers.length === 0) return null;

  const text =
    typingUsers.length === 1
      ? t("typing", { user: typingUsers[0] })
      : t("typingMultiple", { count: typingUsers.length });

  return (
    <div className="typing-indicator">
      <div className="typing-dots">
        <i />
        <i />
        <i />
      </div>
      <span>{text}</span>
    </div>
  );
}

export default TypingIndicator;
