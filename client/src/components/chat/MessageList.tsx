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
 *
 * ChatContext refaktörü:
 * Eskiden doğrudan useMessageStore ve useChannelStore import ediyordu.
 * Artık useChatContext() üzerinden erişiyor — hem channel hem DM'de çalışıyor.
 */

import { useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useChatContext } from "../../hooks/useChatContext";
import { MessageSkeleton } from "../shared/Skeleton";
import Message from "./Message";

/** Aynı yazarın ardışık mesajı compact olacak süre (ms) */
const COMPACT_THRESHOLD = 5 * 60 * 1000;

/**
 * scrollPositions — Kanal bazlı scroll pozisyonu cache'i.
 * Module-level Map kullanılır (component dışında tanımlanır):
 * - Component unmount/remount olsa bile pozisyon korunur
 * - channelId → scrollTop eşlemesi tutar
 */
const scrollPositions = new Map<string, number>();

function MessageList() {
  const { t } = useTranslation("chat");
  const {
    mode,
    channelId,
    channelName,
    messages,
    isLoading,
    isLoadingMore,
    hasMore,
    fetchMessages,
    fetchOlderMessages,
    scrollToMessageId,
    setScrollToMessageId,
  } = useChatContext();

  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);

  // Kanal değiştiğinde mesajları fetch et + auto-scroll'u engelle
  useEffect(() => {
    isAtBottomRef.current = false;

    if (channelId) {
      fetchMessages();
    }
  }, [channelId, fetchMessages]);

  // Yeni mesaj geldiğinde auto-scroll (sadece aktif kanalda)
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && isAtBottomRef.current) {
      scrollToBottom();
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  /**
   * Scroll pozisyonu restore — useLayoutEffect ile paint'ten ÖNCE çalışır.
   */
  useLayoutEffect(() => {
    if (!isLoading && messages.length > 0 && scrollRef.current) {
      const savedPos = scrollPositions.get(channelId);
      if (savedPos !== undefined) {
        scrollRef.current.scrollTop = savedPos;
      } else {
        scrollToBottom();
      }
      prevMessageCountRef.current = messages.length;
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 20;
    }
  }, [isLoading, channelId]);

  /**
   * Scroll-to-message effect — reply preview tıklandığında tetiklenir.
   */
  useEffect(() => {
    if (!scrollToMessageId) return;

    const el = document.getElementById(`msg-${scrollToMessageId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("msg-highlight");
      const timer = setTimeout(() => {
        el.classList.remove("msg-highlight");
      }, 2000);
      setScrollToMessageId(null);
      return () => clearTimeout(timer);
    }

    setScrollToMessageId(null);
  }, [scrollToMessageId, setScrollToMessageId]);

  function scrollToBottom() {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }

  /** Scroll event handler — pozisyon kaydet + en altta mı kontrol et + infinite scroll */
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;

    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 20;

    if (channelId) {
      scrollPositions.set(channelId, scrollTop);
    }

    if (scrollTop < 100 && hasMore && !isLoadingMore && channelId) {
      const prevScrollHeight = scrollRef.current.scrollHeight;
      fetchOlderMessages().then(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop =
            scrollRef.current.scrollHeight - prevScrollHeight;
        }
      });
    }
  }, [hasMore, isLoadingMore, channelId, fetchOlderMessages]);

  /**
   * isCompact — Aynı yazarın 5dk içindeki ardışık mesajı compact gösterilir.
   * Reply mesajları her zaman full header gösterir.
   */
  function isCompact(index: number): boolean {
    if (index === 0) return false;

    const current = messages[index];
    if (current.reply_to_id) return false;

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
      <div className="messages-scroll">
        <MessageSkeleton count={6} />
      </div>
    );
  }

  // Welcome mesajı: Channel modunda "#kanal" ikonu, DM modunda "@kullanıcı" ikonu
  const welcomeIcon = mode === "dm" ? "@" : "#";

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
            <span>{welcomeIcon}</span>
          </div>
          <h2>
            {mode === "dm"
              ? t("welcomeDM", { user: channelName })
              : t("welcomeChannel", { channel: channelName })}
          </h2>
          <p>
            {mode === "dm"
              ? t("dmStart", { user: channelName })
              : t("channelStart", { channel: channelName })}
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "8px 0" }}>
          {messages.map((msg, index) => (
            <div key={msg.id} id={`msg-${msg.id}`}>
              <Message
                message={msg}
                isCompact={isCompact(index)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default MessageList;
