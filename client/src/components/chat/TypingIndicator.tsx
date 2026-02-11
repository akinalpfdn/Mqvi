/**
 * TypingIndicator — "X yazıyor..." gösterimi.
 *
 * messageStore.typingUsers'dan ilgili kanalın typing kullanıcılarını alır.
 * 1 kullanıcı: "X is typing..."
 * 2+ kullanıcı: "N people are typing..."
 *
 * 5 saniye sonra otomatik temizlenir (messageStore tarafında timer ile).
 */

import { useTranslation } from "react-i18next";
import { useMessageStore } from "../../stores/messageStore";
import { useChannelStore } from "../../stores/channelStore";

const EMPTY_TYPING: string[] = [];

function TypingIndicator() {
  const { t } = useTranslation("chat");
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const typingUsers = useMessageStore((s) =>
    selectedChannelId ? s.typingUsers[selectedChannelId] ?? EMPTY_TYPING : EMPTY_TYPING
  );

  if (typingUsers.length === 0) return null;

  const text =
    typingUsers.length === 1
      ? t("typing", { user: typingUsers[0] })
      : t("typingMultiple", { count: typingUsers.length });

  return (
    <div className="flex items-center gap-2 px-4 py-1">
      {/* Animated dots */}
      <div className="flex gap-0.5">
        <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:0ms]" />
        <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:150ms]" />
        <span className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:300ms]" />
      </div>
      <span className="text-xs font-medium text-text-muted">{text}</span>
    </div>
  );
}

export default TypingIndicator;
