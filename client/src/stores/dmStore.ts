/**
 * DM Store — Direct Messages state yönetimi.
 *
 * Tasarım kararları:
 * - channels: DMChannelWithUser[] — tüm DM kanalları (karşı taraf bilgisiyle)
 * - selectedDMId: Seçili DM kanalı ID'si (null = DM görünümünde değil)
 * - messagesByChannel: Record<channelId, DMMessage[]> — DM mesaj cache'i
 * - WS event'leri ile gerçek zamanlı güncelleme
 *
 * Zustand selector stable ref notu:
 * EMPTY_CHANNELS ve EMPTY_MESSAGES module-level sabit olarak tanımlanır.
 */

import { create } from "zustand";
import * as dmApi from "../api/dm";
import type { DMChannelWithUser, DMMessage } from "../types";

const EMPTY_CHANNELS: DMChannelWithUser[] = [];
const EMPTY_MESSAGES: DMMessage[] = [];

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

  // ─── Actions ───
  fetchChannels: () => Promise<void>;
  selectDM: (channelId: string | null) => void;
  createOrGetChannel: (userId: string) => Promise<string | null>;
  fetchMessages: (channelId: string) => Promise<void>;
  fetchOlderMessages: (channelId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string) => Promise<boolean>;
  editMessage: (messageId: string, content: string) => Promise<boolean>;
  deleteMessage: (messageId: string) => Promise<boolean>;

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

  // ─── Helpers ───
  getMessagesForChannel: (channelId: string) => DMMessage[];
};

export const useDMStore = create<DMState>((set, get) => ({
  channels: EMPTY_CHANNELS,
  selectedDMId: null,
  messagesByChannel: {},
  hasMoreByChannel: {},
  dmUnreadCounts: {},
  isLoading: false,
  isLoadingMessages: false,

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
          [channelId]: res.data!.messages,
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

  sendMessage: async (channelId, content) => {
    const res = await dmApi.sendDMMessage(channelId, content);
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

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.dm_channel_id]: [...channelMessages, message],
        },
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

  handleDMMessageDelete: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.dm_channel_id]: channelMessages.filter((m) => m.id !== data.id),
        },
      };
    });
  },

  getMessagesForChannel: (channelId) => {
    return get().messagesByChannel[channelId] ?? EMPTY_MESSAGES;
  },
}));
