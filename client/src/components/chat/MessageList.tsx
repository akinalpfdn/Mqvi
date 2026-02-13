/**
 * MessageList — Scrollable mesaj container'ı.
 *
 * CSS class'ları: .messages-scroll, .msg-welcome, .msg-welcome-icon,
 * .no-channel, .spinner
 *
 * Davranışlar:
 * - Kanal değiştiğinde mesajları fetch eder
 * - Yeni mesaj geldiğinde otomatik scroll (en alttaysa)
 * - Yukarı scroll ile infinite scroll (eski mesajlar)
 * - Mesaj yoksa welcome ekranı
 *
 * Compact mode: Aynı yazarın 5dk içindeki ardışık mesajları compact gösterilir.
 */

import { useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMessageStore } from "../../stores/messageStore";
import { useChannelStore } from "../../stores/channelStore";
import Message from "./Message";
import type { Message as MessageType } from "../../types";

/** Aynı yazarın ardışık mesajı compact olacak süre (ms) */
const COMPACT_THRESHOLD = 5 * 60 * 1000;

const EMPTY_MESSAGES: MessageType[] = [];

type MessageListProps = {
  channelId: string;
};

function MessageList({ channelId }: MessageListProps) {
  const { t } = useTranslation("chat");
  const categories = useChannelStore((s) => s.categories);
  const messages = useMessageStore((s) =>
    channelId
      ? s.messagesByChannel[channelId] ?? EMPTY_MESSAGES
      : EMPTY_MESSAGES
  );
  const hasMore = useMessageStore((s) =>
    channelId ? s.hasMoreByChannel[channelId] ?? false : false
  );
  const isLoading = useMessageStore((s) => s.isLoading);
  const isLoadingMore = useMessageStore((s) => s.isLoadingMore);
  const fetchMessages = useMessageStore((s) => s.fetchMessages);
  const fetchOlderMessages = useMessageStore((s) => s.fetchOlderMessages);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);

  const channelName = categories
    .flatMap((cg) => cg.channels)
    .find((ch) => ch.id === channelId)?.name ?? "";

  // Kanal değiştiğinde mesajları fetch et
  useEffect(() => {
    if (channelId) {
      fetchMessages(channelId);
    }
  }, [channelId, fetchMessages]);

  // Yeni mesaj geldiğinde auto-scroll
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && isAtBottomRef.current) {
      scrollToBottom();
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  // İlk yükleme sonrası scroll to bottom
  useEffect(() => {
    if (!isLoading && messages.length > 0) {
      scrollToBottom();
    }
  }, [isLoading]);

  function scrollToBottom() {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }

  /** Scroll event handler — en altta mı kontrol et + infinite scroll */
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;

    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 20;

    if (scrollTop < 100 && hasMore && !isLoadingMore && channelId) {
      const prevScrollHeight = scrollRef.current.scrollHeight;
      fetchOlderMessages(channelId).then(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop =
            scrollRef.current.scrollHeight - prevScrollHeight;
        }
      });
    }
  }, [hasMore, isLoadingMore, channelId, fetchOlderMessages]);

  /**
   * isCompact — Aynı yazarın 5dk içindeki ardışık mesajı compact gösterilir.
   */
  function isCompact(index: number): boolean {
    if (index === 0) return false;

    const current = messages[index];
    const previous = messages[index - 1];

    if (current.user_id !== previous.user_id) return false;

    const timeDiff =
      new Date(current.created_at).getTime() -
      new Date(previous.created_at).getTime();

    return timeDiff < COMPACT_THRESHOLD;
  }

  if (!channelId) {
    return <div className="no-channel">Select a channel</div>;
  }

  if (isLoading) {
    return (
      <div className="no-channel">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="messages-scroll"
    >
      {/* Loading more indicator */}
      {isLoadingMore && (
        <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
          <div className="spinner" />
        </div>
      )}

      {/* Mesajlar */}
      {messages.length === 0 ? (
        <div className="msg-welcome">
          <div className="msg-welcome-icon">
            <span>#</span>
          </div>
          <h2>{t("welcomeChannel", { channel: channelName })}</h2>
          <p>{t("channelStart", { channel: channelName })}</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "8px 0" }}>
          {messages.map((msg, index) => (
            <Message
              key={msg.id}
              message={msg}
              isCompact={isCompact(index)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default MessageList;
