/**
 * ChatArea — Orta panel: kanal başlığı, mesajlar ve mesaj input.
 *
 * Discord referans spacing'leri:
 * - Header: h-header(48px), hash + isim + divider + topic
 * - Messages: geniş padding, alt hizalı
 * - Input: rounded-lg, 44px yükseklik, generous padding
 */

import { useTranslation } from "react-i18next";
import { useChannelStore } from "../../stores/channelStore";
import MessageList from "../chat/MessageList";
import MessageInput from "../chat/MessageInput";
import TypingIndicator from "../chat/TypingIndicator";

type ChatAreaProps = {
  sendTyping: (channelId: string) => void;
};

function ChatArea({ sendTyping }: ChatAreaProps) {
  const { t } = useTranslation("chat");
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const categories = useChannelStore((s) => s.categories);

  /** Seçili kanalın bilgilerini bul */
  const selectedChannel = categories
    .flatMap((cg) => cg.channels)
    .find((ch) => ch.id === selectedChannelId);

  const channelName = selectedChannel?.name ?? "";

  return (
    <div className="flex flex-1 flex-col bg-background">
      {/* ─── Channel Header ─── */}
      <div className="flex h-header shrink-0 items-center border-b border-background-tertiary px-4 shadow-sm">
        {selectedChannel ? (
          <>
            <div className="flex items-center gap-2.5">
              <span className="text-2xl leading-none text-text-muted">
                {selectedChannel.type === "text" ? "#" : (
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M12 6a7 7 0 010 14M8.464 8.464a5 5 0 000 7.072" />
                  </svg>
                )}
              </span>
              <h3 className="text-[15px] font-semibold text-text-primary">{channelName}</h3>
            </div>

            {selectedChannel.topic && (
              <>
                <div className="mx-4 h-6 w-px bg-background-tertiary" />
                <p className="truncate text-sm text-text-muted">
                  {selectedChannel.topic}
                </p>
              </>
            )}
          </>
        ) : (
          <p className="text-sm text-text-muted">{t("channelStart", { channel: "" })}</p>
        )}
      </div>

      {/* ─── Messages Area ─── */}
      <MessageList />

      {/* ─── Typing Indicator ─── */}
      <TypingIndicator />

      {/* ─── Message Input ─── */}
      <MessageInput sendTyping={sendTyping} />
    </div>
  );
}

export default ChatArea;
