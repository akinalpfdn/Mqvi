/**
 * DM Store — Direct Messages state yönetimi.
 *
 * Tasarım kararları:
 * - channels: DMChannelWithUser[] — tüm DM kanalları (karşı taraf bilgisiyle)
 * - selectedDMId: Seçili DM kanalı ID'si (null = DM görünümünde değil)
 * - messagesByChannel: Record<channelId, DMMessage[]> — DM mesaj cache'i
 * - WS event'leri ile gerçek zamanlı güncelleme
 *
 * Feature parity notu:
 * Channel chat ile aynı özellikleri destekler:
 * - Reply (replyingTo + scrollToMessageId)
 * - Reactions (toggleReaction + handleDMReactionUpdate)
 * - Typing indicator (typingUsers + handleDMTypingStart)
 * - Pin (pinMessage/unpinMessage + handleDMMessagePin/Unpin)
 * - File upload (sendMessage files parametresi)
 * - Search (searchMessages)
 *
 * Zustand selector stable ref notu:
 * EMPTY_CHANNELS ve EMPTY_MESSAGES module-level sabit olarak tanımlanır.
 */

import { create } from "zustand";
import i18n from "../i18n";
import * as dmApi from "../api/dm";
import type { DMSearchResult } from "../api/dm";
import type { DMChannelWithUser, DMMessage, ReactionGroup } from "../types";
import { useToastStore } from "./toastStore";

const EMPTY_CHANNELS: DMChannelWithUser[] = [];
const EMPTY_MESSAGES: DMMessage[] = [];
const EMPTY_STRINGS: string[] = [];

/** Typing indicator otomatik temizleme süresi (ms) */
const TYPING_TIMEOUT = 5_000;

/** Typing timer'ları: `channelId:username` → timeout ID */
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

type DMState = {
  /** Tüm DM kanalları */
  channels: DMChannelWithUser[];
  /** Seçili DM kanalı ID'si */
  selectedDMId: string | null;
  /** DM mesaj cache'i: channelId → DMMessage[] */
  messagesByChannel: Record<string, DMMessage[]>;
  /** Kanal bazlı "daha eski mesaj var mı?" */
  hasMoreByChannel: Record<string, boolean>;
  /** DM okunmamış mesaj sayıları: channelId → count */
  dmUnreadCounts: Record<string, number>;
  /** Yüklenme durumları */
  isLoading: boolean;
  isLoadingMessages: boolean;

  // ─── Reply State ───
  /** Yanıt verilmekte olan mesaj (input üstünde ReplyBar gösterilir) */
  replyingTo: DMMessage | null;
  /** Scroll-to-message: Bu ID'ye sahip mesaja scroll et ve highlight yap */
  scrollToMessageId: string | null;

  // ─── Typing State ───
  /** Kanal bazlı typing kullanıcıları: channelId → username[] */
  typingUsers: Record<string, string[]>;

  // ─── Actions ───
  fetchChannels: () => Promise<void>;
  selectDM: (channelId: string | null) => void;
  createOrGetChannel: (userId: string) => Promise<string | null>;
  fetchMessages: (channelId: string) => Promise<void>;
  fetchOlderMessages: (channelId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string) => Promise<boolean>;
  editMessage: (messageId: string, content: string) => Promise<boolean>;
  deleteMessage: (messageId: string) => Promise<boolean>;

  // ─── Reply Actions ───
  setReplyingTo: (message: DMMessage | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  // ─── Reactions ───
  toggleReaction: (messageId: string, channelId: string, emoji: string) => Promise<void>;

  // ─── Pin ───
  pinMessage: (channelId: string, messageId: string) => Promise<void>;
  unpinMessage: (channelId: string, messageId: string) => Promise<void>;
  getPinnedMessages: (channelId: string) => Promise<DMMessage[]>;

  // ─── Search ───
  searchMessages: (channelId: string, query: string, limit?: number, offset?: number) => Promise<DMSearchResult>;

  // ─── Unread ───
  /** DM okunmamış sayacını artır (mesaj başka birinden geldiğinde) */
  incrementDMUnread: (channelId: string) => void;
  /** DM mesaj silindiğinde okunmamış sayacını azalt (0'ın altına düşmez) */
  decrementDMUnread: (channelId: string) => void;
  /** DM okunmamış sayacını sıfırla (kanal açıldığında) */
  clearDMUnread: (channelId: string) => void;
  /** Toplam DM okunmamış sayısı */
  getTotalDMUnread: () => number;

  // ─── WS Event Handlers ───
  handleDMChannelCreate: (channel: DMChannelWithUser) => void;
  handleDMMessageCreate: (message: DMMessage) => void;
  handleDMMessageUpdate: (message: DMMessage) => void;
  handleDMMessageDelete: (data: { id: string; dm_channel_id: string }) => void;
  handleDMReactionUpdate: (data: { dm_message_id: string; dm_channel_id: string; reactions: ReactionGroup[] }) => void;
  handleDMTypingStart: (channelId: string, username: string) => void;
  handleDMMessagePin: (data: { dm_channel_id: string; message: DMMessage }) => void;
  handleDMMessageUnpin: (data: { dm_channel_id: string; message_id: string }) => void;

  // ─── Helpers ───
  getMessagesForChannel: (channelId: string) => DMMessage[];
  getTypingUsers: (channelId: string) => string[];
};

export const useDMStore = create<DMState>((set, get) => ({
  channels: EMPTY_CHANNELS,
  selectedDMId: null,
  messagesByChannel: {},
  hasMoreByChannel: {},
  dmUnreadCounts: {},
  isLoading: false,
  isLoadingMessages: false,
  replyingTo: null,
  scrollToMessageId: null,
  typingUsers: {},

  fetchChannels: async () => {
    set({ isLoading: true });
    const res = await dmApi.listDMChannels();
    if (res.success && res.data) {
      set({ channels: res.data, isLoading: false });
    } else {
      set({ isLoading: false });
    }
  },

  selectDM: (channelId) => {
    set({ selectedDMId: channelId });
  },

  createOrGetChannel: async (userId) => {
    const res = await dmApi.createDMChannel(userId);
    if (res.success && res.data) {
      // Kanal zaten listede yoksa ekle
      set((state) => {
        const exists = state.channels.some((ch) => ch.id === res.data!.id);
        if (exists) return state;
        return { channels: [res.data!, ...state.channels] };
      });
      return res.data.id;
    }
    return null;
  },

  fetchMessages: async (channelId) => {
    if (get().messagesByChannel[channelId]) return;
    set({ isLoadingMessages: true });

    const res = await dmApi.getDMMessages(channelId, undefined, 50);
    if (res.success && res.data) {
      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: res.data!.messages ?? [],
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: res.data!.has_more,
        },
        isLoadingMessages: false,
      }));
    } else {
      set({ isLoadingMessages: false });
    }
  },

  fetchOlderMessages: async (channelId) => {
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreByChannel[channelId]) return;

    const beforeId = messages[0].id;
    const res = await dmApi.getDMMessages(channelId, beforeId, 50);
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
      }));
    }
  },

  /**
   * sendMessage — DM mesajı gönderir.
   *
   * Channel sendMessage ile aynı pattern:
   * - files parametresi varsa multipart/form-data (FormData)
   * - replyToId parametresi varsa yanıt mesajı olarak gönderilir
   * - Mesaj WS üzerinden gelecek (handleDMMessageCreate), HTTP response beklemeye gerek yok
   */
  sendMessage: async (channelId, content, files, replyToId) => {
    const res = await dmApi.sendDMMessage(channelId, content, files, replyToId);

    // Rate limit aşıldıysa kullanıcıya toast ile bildir
    if (!res.success && res.error?.includes("too many")) {
      useToastStore.getState().addToast("warning", i18n.t("chat:tooManyMessages"));
    }

    return res.success;
  },

  editMessage: async (messageId, content) => {
    const res = await dmApi.editDMMessage(messageId, content);
    return res.success;
  },

  deleteMessage: async (messageId) => {
    const res = await dmApi.deleteDMMessage(messageId);
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
   * toggleReaction — Bir DM mesajına emoji reaction ekler veya kaldırır.
   *
   * API çağrısı yapar, sonuç WS broadcast ile gelecek (handleDMReactionUpdate).
   * Optimistic update yapmıyoruz — WS event ile güncellenecek.
   */
  toggleReaction: async (messageId, _channelId, emoji) => {
    await dmApi.toggleDMReaction(messageId, emoji);
  },

  // ─── Pin ───

  pinMessage: async (_channelId, messageId) => {
    await dmApi.pinDMMessage(messageId);
    // WS event (dm_message_pin) ile state güncellenecek
  },

  unpinMessage: async (_channelId, messageId) => {
    await dmApi.unpinDMMessage(messageId);
    // WS event (dm_message_unpin) ile state güncellenecek
  },

  getPinnedMessages: async (channelId) => {
    const res = await dmApi.getDMPinnedMessages(channelId);
    if (res.success && res.data) {
      return res.data;
    }
    return [];
  },

  // ─── Search ───

  searchMessages: async (channelId, query, limit = 25, offset = 0) => {
    const res = await dmApi.searchDMMessages(channelId, query, limit, offset);
    if (res.success && res.data) {
      return res.data;
    }
    return { messages: [], total_count: 0 };
  },

  // ─── Unread ───

  incrementDMUnread: (channelId) => {
    set((state) => ({
      dmUnreadCounts: {
        ...state.dmUnreadCounts,
        [channelId]: (state.dmUnreadCounts[channelId] ?? 0) + 1,
      },
    }));
  },

  decrementDMUnread: (channelId) => {
    set((state) => {
      const current = state.dmUnreadCounts[channelId] ?? 0;
      if (current <= 0) return state;

      if (current === 1) {
        const next = { ...state.dmUnreadCounts };
        delete next[channelId];
        return { dmUnreadCounts: next };
      }

      return {
        dmUnreadCounts: {
          ...state.dmUnreadCounts,
          [channelId]: current - 1,
        },
      };
    });
  },

  clearDMUnread: (channelId) => {
    set((state) => {
      if (!state.dmUnreadCounts[channelId]) return state;
      const next = { ...state.dmUnreadCounts };
      delete next[channelId];
      return { dmUnreadCounts: next };
    });
  },

  getTotalDMUnread: () => {
    const counts = get().dmUnreadCounts;
    return Object.values(counts).reduce((sum, c) => sum + c, 0);
  },

  // ─── WS Event Handlers ───

  handleDMChannelCreate: (channel) => {
    set((state) => {
      // Duplicate kontrolü
      if (state.channels.some((ch) => ch.id === channel.id)) return state;
      return { channels: [channel, ...state.channels] };
    });
  },

  handleDMMessageCreate: (message) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[message.dm_channel_id];
      if (!channelMessages) return state;
      if (channelMessages.some((m) => m.id === message.id)) return state;

      // Typing indicator'ı temizle (mesaj geldi = yazmayı bitirdi)
      const typingUsers = { ...state.typingUsers };
      if (typingUsers[message.dm_channel_id]) {
        typingUsers[message.dm_channel_id] = typingUsers[message.dm_channel_id].filter(
          (u) => u !== message.author?.username
        );
      }

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.dm_channel_id]: [...channelMessages, message],
        },
        typingUsers,
      };
    });
  },

  handleDMMessageUpdate: (message) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[message.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.dm_channel_id]: channelMessages.map((m) =>
            m.id === message.id ? message : m
          ),
        },
      };
    });
  },

  /**
   * handleDMMessageDelete — DM mesajı silindiğinde çağrılır.
   *
   * Silinen mesajı listeden çıkarır + ona reply yapan mesajların
   * referenced_message'ını null'a çevir → "Orijinal mesaj silindi" gösterilir.
   * (Channel messageStore ile aynı pattern)
   */
  handleDMMessageDelete: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

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
          [data.dm_channel_id]: updated,
        },
      };
    });
  },

  /**
   * handleDMReactionUpdate — WS dm_reaction_update event'i geldiğinde çağrılır.
   *
   * Backend her toggle sonrası tam reaction listesini gönderir —
   * doğrudan replace (channel messageStore ile aynı pattern).
   */
  handleDMReactionUpdate: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.dm_channel_id]: channelMessages.map((m) =>
            m.id === data.dm_message_id
              ? { ...m, reactions: data.reactions }
              : m
          ),
        },
      };
    });
  },

  /**
   * handleDMTypingStart — DM kanalında kullanıcı yazmaya başladığında çağrılır.
   *
   * 5 saniye sonra otomatik temizlenir (kullanıcı yazmayı bırakırsa
   * yeni typing event gelmez → timer ile temizlenir).
   * (Channel messageStore handleTypingStart ile aynı pattern)
   */
  handleDMTypingStart: (channelId, username) => {
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
   * handleDMMessagePin — DM mesajı sabitlendiğinde çağrılır.
   *
   * Backend tam enriched DMMessage gönderir — is_pinned:true.
   * Store'daki ilgili mesajı güncelle.
   */
  handleDMMessagePin: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.dm_channel_id]: channelMessages.map((m) =>
            m.id === data.message.id ? { ...m, is_pinned: true } : m
          ),
        },
      };
    });
  },

  /**
   * handleDMMessageUnpin — DM mesajı pin'den çıkarıldığında çağrılır.
   *
   * Backend message_id gönderir — ilgili mesajın is_pinned'ını false yap.
   */
  handleDMMessageUnpin: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.dm_channel_id]: channelMessages.map((m) =>
            m.id === data.message_id ? { ...m, is_pinned: false } : m
          ),
        },
      };
    });
  },

  // ─── Helpers ───

  getMessagesForChannel: (channelId) => {
    return get().messagesByChannel[channelId] ?? EMPTY_MESSAGES;
  },

  getTypingUsers: (channelId) => {
    return get().typingUsers[channelId] ?? EMPTY_STRINGS;
  },
}));
