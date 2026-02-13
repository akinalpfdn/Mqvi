/**
 * TypingIndicator — "X yazıyor..." gösterimi.
 *
 * CSS class'ları: .typing-indicator, .typing-dots
 *
 * Animasyon: .typing-dots i { animation: bip ... }
 * nth-child delay'leri CSS'te tanımlıdır.
 *
 * channelId prop olarak ChatArea'dan gelir.
 */

import { useTranslation } from "react-i18next";
import { useMessageStore } from "../../stores/messageStore";

const EMPTY_TYPING: string[] = [];

type TypingIndicatorProps = {
  channelId: string;
};

function TypingIndicator({ channelId }: TypingIndicatorProps) {
  const { t } = useTranslation("chat");
  const typingUsers = useMessageStore((s) =>
    channelId ? s.typingUsers[channelId] ?? EMPTY_TYPING : EMPTY_TYPING
  );

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
