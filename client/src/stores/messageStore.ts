/**
 * Message Store — Zustand ile mesaj state yönetimi.
 *
 * Tasarım kararları:
 * - messagesByChannel: Kanal değiştirince cache'den gösterir, yoksa fetch eder.
 *   Record<channelId, Message[]> formatında — her kanalın mesajları ayrı tutulur.
 * - Mesajlar created_at ASC sıralı (en eski üstte, en yeni altta).
 * - WebSocket "message_create" → dizinin sonuna ekler (yeni mesaj altta).
 * - Cursor pagination: fetchOlderMessages dizideki ilk mesajın ID'sini "before" olarak gönderir.
 * - typingUsers: Hangi kullanıcıların yazmakta olduğunu takip eder (typing indicator için).
 */

import { create } from "zustand";
import * as messageApi from "../api/messages";
import * as reactionApi from "../api/reactions";
import type { Message, ReactionGroup } from "../types";
import { DEFAULT_MESSAGE_LIMIT } from "../utils/constants";

type MessageState = {
  /** Kanal bazlı mesaj cache'i: channelId → Message[] */
  messagesByChannel: Record<string, Message[]>;
  /** Kanal bazlı "daha eski mesaj var mı?" bilgisi */
  hasMoreByChannel: Record<string, boolean>;
  /** Yüklenme durumu (ilk yükleme) */
  isLoading: boolean;
  /** Daha eski mesajlar yüklenirken */
  isLoadingMore: boolean;
  /** Kanal bazlı typing kullanıcıları: channelId → username[] */
  typingUsers: Record<string, string[]>;

  // ─── Reply State ───
  /** Yanıt verilmekte olan mesaj (input üstünde ReplyBar gösterilir) */
  replyingTo: Message | null;
  /** Scroll-to-message: Bu ID'ye sahip mesaja scroll et ve highlight yap */
  scrollToMessageId: string | null;

  // ─── Actions ───
  fetchMessages: (channelId: string) => Promise<void>;
  fetchOlderMessages: (channelId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string) => Promise<boolean>;
  editMessage: (messageId: string, content: string) => Promise<boolean>;
  deleteMessage: (messageId: string) => Promise<boolean>;

  // ─── Reply Actions ───
  setReplyingTo: (message: Message | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  // ─── Reactions ───
  toggleReaction: (messageId: string, channelId: string, emoji: string) => Promise<void>;

  // ─── WS Event Handlers ───
  handleMessageCreate: (message: Message) => void;
  handleMessageUpdate: (message: Message) => void;
  handleMessageDelete: (data: { id: string; channel_id: string }) => void;
  handleTypingStart: (channelId: string, username: string) => void;
  handleReactionUpdate: (data: { message_id: string; channel_id: string; reactions: ReactionGroup[] }) => void;
};

/** Typing indicator otomatik temizleme süresi (ms) */
const TYPING_TIMEOUT = 5_000;

/** Typing timer'ları: `channelId:username` → timeout ID */
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useMessageStore = create<MessageState>((set, get) => ({
  messagesByChannel: {},
  hasMoreByChannel: {},
  isLoading: false,
  isLoadingMore: false,
  typingUsers: {},
  replyingTo: null,
  scrollToMessageId: null,

  /**
   * fetchMessages — Bir kanalın mesajlarını ilk kez yükler.
   * Cache'de varsa tekrar çekmez (kanal değiştirince hızlı geçiş).
   */
  fetchMessages: async (channelId) => {
    // Cache'de varsa tekrar çekme
    if (get().messagesByChannel[channelId]) return;

    set({ isLoading: true });

    const res = await messageApi.getMessages(channelId, undefined, DEFAULT_MESSAGE_LIMIT);
    if (res.success && res.data) {
      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: res.data!.messages,
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: res.data!.has_more,
        },
        isLoading: false,
      }));
    } else {
      set({ isLoading: false });
    }
  },

  /**
   * fetchOlderMessages — Daha eski mesajları yükler (yukarı scroll).
   * Cursor: cache'deki ilk mesajın ID'si "before" parametresi olarak gönderilir.
   */
  fetchOlderMessages: async (channelId) => {
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreByChannel[channelId]) return;

    set({ isLoadingMore: true });

    // İlk mesajın ID'si cursor olur (en eski mesaj dizinin başında)
    const beforeId = messages[0].id;
    const res = await messageApi.getMessages(channelId, beforeId, DEFAULT_MESSAGE_LIMIT);

    if (res.success && res.data) {
      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: [...res.data!.messages, ...state.messagesByChannel[channelId]],
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: res.data!.has_more,
        },
        isLoadingMore: false,
      }));
    } else {
      set({ isLoadingMore: false });
    }
  },

  sendMessage: async (channelId, content, files, replyToId) => {
    const res = await messageApi.sendMessage(channelId, content, files, replyToId);
    // Mesaj WS üzerinden gelecek (handleMessageCreate), HTTP response'u beklemeye gerek yok
    return res.success;
  },

  editMessage: async (messageId, content) => {
    const res = await messageApi.editMessage(messageId, content);
    return res.success;
  },

  deleteMessage: async (messageId) => {
    const res = await messageApi.deleteMessage(messageId);
    return res.success;
  },

  // ─── Reply Actions ───

  setReplyingTo: (message) => set({ replyingTo: message }),

  /**
   * setScrollToMessageId — Belirtilen mesaja scroll et.
   * Değer set edildikten sonra UI tarafında scrollIntoView + highlight yapılır,
   * ardından null'a sıfırlanır (tek seferlik tetikleme).
   */
  setScrollToMessageId: (id) => set({ scrollToMessageId: id }),

  // ─── Reactions ───

  /**
   * toggleReaction — Bir mesaja emoji reaction ekler veya kaldırır.
   *
   * API çağrısı yapar, sonuç WS broadcast ile gelecek (handleReactionUpdate).
   * Optimistic update yapmıyoruz — WS event ile güncellenecek.
   * Bu daha basit ve race condition riski yok.
   */
  toggleReaction: async (messageId, _channelId, emoji) => {
    await reactionApi.toggleReaction(messageId, emoji);
  },

  // ─── WebSocket Event Handlers ───

  /**
   * handleMessageCreate — Yeni mesaj geldiğinde çağrılır.
   * Mesajı ilgili kanalın dizisinin sonuna ekler (en yeni altta).
   * Aynı zamanda typing indicator'ı temizler (mesaj geldi = yazmayı bitirdi).
   */
  handleMessageCreate: (message) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[message.channel_id];
      // Kanal henüz yüklenmemişse ekleme — kullanıcı o kanala geçince fetch edecek
      if (!channelMessages) return state;

      // Duplicate kontrolü (aynı mesaj iki kez gelmesin)
      if (channelMessages.some((m) => m.id === message.id)) return state;

      // Typing indicator'ı temizle
      const typingUsers = { ...state.typingUsers };
      if (typingUsers[message.channel_id]) {
        typingUsers[message.channel_id] = typingUsers[message.channel_id].filter(
          (u) => u !== message.author?.username
        );
      }

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.channel_id]: [...channelMessages, message],
        },
        typingUsers,
      };
    });
  },

  handleMessageUpdate: (message) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[message.channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.channel_id]: channelMessages.map((m) =>
            m.id === message.id ? message : m
          ),
        },
      };
    });
  },

  handleMessageDelete: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.channel_id];
      if (!channelMessages) return state;

      // Silinen mesajı listeden çıkar + ona reply yapan mesajların
      // referenced_message'ını null'a çevir → "Orijinal mesaj silindi" gösterilir.
      const updated = channelMessages
        .filter((m) => m.id !== data.id)
        .map((m) =>
          m.reply_to_id === data.id
            ? { ...m, referenced_message: { id: data.id, author: null, content: null } }
            : m
        );

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.channel_id]: updated,
        },
      };
    });
  },

  /**
   * handleTypingStart — Bir kullanıcı yazmaya başladığında çağrılır.
   *
   * 5 saniye sonra otomatik temizlenir (kullanıcı yazmayı bırakırsa
   * yeni typing event gelmez → timer ile temizlenir).
   */
  handleTypingStart: (channelId, username) => {
    set((state) => {
      const current = state.typingUsers[channelId] ?? [];
      if (current.includes(username)) return state;

      return {
        typingUsers: {
          ...state.typingUsers,
          [channelId]: [...current, username],
        },
      };
    });

    // Mevcut timer'ı iptal et ve yenisini kur
    const key = `${channelId}:${username}`;
    const existingTimer = typingTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);

    typingTimers.set(
      key,
      setTimeout(() => {
        set((state) => ({
          typingUsers: {
            ...state.typingUsers,
            [channelId]: (state.typingUsers[channelId] ?? []).filter(
              (u) => u !== username
            ),
          },
        }));
        typingTimers.delete(key);
      }, TYPING_TIMEOUT)
    );
  },

  /**
   * handleReactionUpdate — WS reaction_update event'i geldiğinde çağrılır.
   *
   * İlgili mesajın reactions alanını güncel listeyle değiştirir.
   * Backend her toggle sonrası tam reaction listesini gönderir —
   * bu sayede client-side merge'e gerek kalmaz, doğrudan replace.
   */
  handleReactionUpdate: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.channel_id]: channelMessages.map((m) =>
            m.id === data.message_id
              ? { ...m, reactions: data.reactions }
              : m
          ),
        },
      };
    });
  },
}));
