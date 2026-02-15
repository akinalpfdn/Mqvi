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

import { useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMessageStore } from "../../stores/messageStore";
import { useChannelStore } from "../../stores/channelStore";
import { MessageSkeleton } from "../shared/Skeleton";
import Message from "./Message";
import type { Message as MessageType } from "../../types";

/** Aynı yazarın ardışık mesajı compact olacak süre (ms) */
const COMPACT_THRESHOLD = 5 * 60 * 1000;

const EMPTY_MESSAGES: MessageType[] = [];

/**
 * scrollPositions — Kanal bazlı scroll pozisyonu cache'i.
 *
 * Module-level Map kullanılır (component dışında tanımlanır):
 * - Component unmount/remount olsa bile pozisyon korunur
 * - channelId → scrollTop eşlemesi tutar
 * - Bellek kullanımı ihmal edilebilir düzeydedir (birkaç string-number çifti)
 *
 * Alternatif: Zustand store'da tutulabilirdi ama bu tamamen local bir
 * concern olduğundan (hiçbir başka component erişmez) module-level
 * Map daha uygun.
 */
const scrollPositions = new Map<string, number>();

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
  const scrollToMessageId = useMessageStore((s) => s.scrollToMessageId);
  const setScrollToMessageId = useMessageStore((s) => s.setScrollToMessageId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);

  const channelName = categories
    .flatMap((cg) => cg.channels)
    .find((ch) => ch.id === channelId)?.name ?? "";

  // Kanal değiştiğinde mesajları fetch et + auto-scroll'u engelle
  useEffect(() => {
    // Kanal geçişi sırasında auto-scroll'u engelle.
    // isAtBottomRef false yapılmazsa, auto-scroll effect kanal değişiminde de
    // tetiklenir ve restore edilen scroll pozisyonunu override eder.
    isAtBottomRef.current = false;

    if (channelId) {
      fetchMessages(channelId);
    }
  }, [channelId, fetchMessages]);

  // Yeni mesaj geldiğinde auto-scroll (sadece aktif kanalda, kanal geçişinde değil)
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && isAtBottomRef.current) {
      scrollToBottom();
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length]);

  /**
   * Scroll pozisyonu restore — useLayoutEffect ile paint'ten ÖNCE çalışır.
   *
   * Neden useLayoutEffect?
   * React DOM'u commit ettikten sonra, tarayıcı paint etmeden önce çalışır.
   * useEffect kullanılsaydı, tarayıcı önce scrollTop=0 ile boyar, sonra
   * pozisyonu geri yüklerdi — bu da bir "flash" efekti yaratırdı.
   *
   * Scroll pozisyonu kaydetme handleScroll'da sürekli yapılır (aşağıda),
   * channel-change effect'te değil. Çünkü useEffect çalıştığında DOM zaten
   * yeni kanalın içeriğiyle güncellenmiş ve scrollTop sıfırlanmış olur.
   */
  useLayoutEffect(() => {
    if (!isLoading && messages.length > 0 && scrollRef.current) {
      const savedPos = scrollPositions.get(channelId);
      if (savedPos !== undefined) {
        scrollRef.current.scrollTop = savedPos;
      } else {
        scrollToBottom();
      }
      // Pozisyon ayarlandıktan sonra tracking ref'leri güncelle —
      // sonraki yeni mesajlarda doğru karşılaştırma yapılabilsin.
      prevMessageCountRef.current = messages.length;
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 20;
    }
  }, [isLoading, channelId]);

  /**
   * Scroll-to-message effect — reply preview tıklandığında tetiklenir.
   * Hedef mesaja scroll eder ve kısa süreliğine highlight animasyonu uygular.
   * scrollToMessageId set edildikten sonra tek seferlik çalışır ve null'a sıfırlanır.
   */
  useEffect(() => {
    if (!scrollToMessageId) return;

    const el = document.getElementById(`msg-${scrollToMessageId}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("msg-highlight");
      // Highlight'ı kaldır — CSS transition ile fade out
      const timer = setTimeout(() => {
        el.classList.remove("msg-highlight");
      }, 2000);
      setScrollToMessageId(null);
      return () => clearTimeout(timer);
    }

    // Mesaj DOM'da bulunamadı (henüz yüklenmemiş olabilir) — state'i temizle
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

    // Scroll pozisyonunu sürekli kaydet — kanal geçişlerinde restore etmek için.
    // Bu kaydetme handleScroll'da yapılır (useEffect'te değil), çünkü
    // useEffect çalıştığında DOM zaten değişmiş ve scrollTop sıfırlanmış olur.
    if (channelId) {
      scrollPositions.set(channelId, scrollTop);
    }

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
   * Reply mesajları her zaman full header gösterir (compact değil) —
   * referans preview'ın yazar + zaman bilgisi ile birlikte görünmesi gerekir.
   */
  function isCompact(index: number): boolean {
    if (index === 0) return false;

    const current = messages[index];
    // Reply mesajlar her zaman full header gösterir
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
