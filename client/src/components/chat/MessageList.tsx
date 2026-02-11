/**
 * MessageList — Scrollable mesaj container'ı.
 *
 * Davranışlar:
 * - Kanal değiştiğinde mesajları fetch eder (cache varsa cache'den gösterir)
 * - Yeni mesaj geldiğinde otomatik scroll (kullanıcı en alttaysa)
 * - Yukarı scroll ile eski mesajları yükler (infinite scroll)
 * - Mesaj yoksa welcome ekranı gösterir
 *
 * Compact mode:
 * Aynı yazarın 5 dakika içindeki ardışık mesajları compact gösterilir
 * (avatar ve username tekrarlanmaz).
 */

import { useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useMessageStore } from "../../stores/messageStore";
import { useChannelStore } from "../../stores/channelStore";
import Message from "./Message";
import type { Message as MessageType } from "../../types";

/** Aynı yazarın ardışık mesajı compact olacak süre (ms) */
const COMPACT_THRESHOLD = 5 * 60 * 1000; // 5 dakika

/**
 * Stabil boş array referansı — Zustand selector'ında `?? []` kullanırsak
 * her render'da yeni array oluşur, React bunu "değişti" sanır ve sonsuz
 * re-render döngüsüne girer. Modül seviyesinde tanımlanan sabit referans
 * bu sorunu çözer.
 */
const EMPTY_MESSAGES: MessageType[] = [];

function MessageList() {
  const { t } = useTranslation("chat");
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const categories = useChannelStore((s) => s.categories);
  const messages = useMessageStore((s) =>
    selectedChannelId
      ? s.messagesByChannel[selectedChannelId] ?? EMPTY_MESSAGES
      : EMPTY_MESSAGES
  );
  const hasMore = useMessageStore((s) =>
    selectedChannelId ? s.hasMoreByChannel[selectedChannelId] ?? false : false
  );
  const isLoading = useMessageStore((s) => s.isLoading);
  const isLoadingMore = useMessageStore((s) => s.isLoadingMore);
  const fetchMessages = useMessageStore((s) => s.fetchMessages);
  const fetchOlderMessages = useMessageStore((s) => s.fetchOlderMessages);

  /** Scroll container referansı */
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Kullanıcı en altta mı? (auto-scroll kontrolü) */
  const isAtBottomRef = useRef(true);
  /** Son mesaj sayısı (yeni mesaj tespiti) */
  const prevMessageCountRef = useRef(0);

  /** Seçili kanalın adını bul */
  const channelName = categories
    .flatMap((cg) => cg.channels)
    .find((ch) => ch.id === selectedChannelId)?.name ?? "";

  // Kanal değiştiğinde mesajları fetch et
  useEffect(() => {
    if (selectedChannelId) {
      fetchMessages(selectedChannelId);
    }
  }, [selectedChannelId, fetchMessages]);

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

    // En altta mı? (20px tolerans)
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 20;

    // Yukarı scroll — eski mesajları yükle
    if (scrollTop < 100 && hasMore && !isLoadingMore && selectedChannelId) {
      const prevScrollHeight = scrollRef.current.scrollHeight;
      fetchOlderMessages(selectedChannelId).then(() => {
        // Scroll pozisyonunu koru (yeni mesajlar üste eklenince kayma)
        if (scrollRef.current) {
          scrollRef.current.scrollTop =
            scrollRef.current.scrollHeight - prevScrollHeight;
        }
      });
    }
  }, [hasMore, isLoadingMore, selectedChannelId, fetchOlderMessages]);

  /**
   * isCompact — Mesajın compact modda gösterilip gösterilmeyeceğini belirler.
   * Aynı yazarın 5 dakika içindeki ardışık mesajı compact gösterilir.
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

  if (!selectedChannelId) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-text-muted">Select a channel</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-sm text-text-muted">...</span>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex flex-1 flex-col overflow-y-auto"
    >
      {/* Loading more indicator */}
      {isLoadingMore && (
        <div className="flex justify-center py-4">
          <span className="text-sm text-text-muted">...</span>
        </div>
      )}

      {/* Mesajlar */}
      {messages.length === 0 ? (
        /* Welcome placeholder — mesaj yoksa */
        <div className="flex flex-1 flex-col items-center justify-end px-8 py-16 text-center">
          <div className="mb-4 flex h-[76px] w-[76px] items-center justify-center rounded-full bg-surface">
            <span className="text-[42px] leading-none text-text-muted">#</span>
          </div>
          <h2 className="mb-2 text-[32px] font-bold leading-tight text-text-primary">
            {t("welcomeChannel", { channel: channelName })}
          </h2>
          <p className="max-w-lg text-base leading-relaxed text-text-muted">
            {t("channelStart", { channel: channelName })}
          </p>
        </div>
      ) : (
        <div className="flex flex-col justify-end pb-4">
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
