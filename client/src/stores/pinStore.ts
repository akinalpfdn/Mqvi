/**
 * pinStore — Mesaj sabitleme state yönetimi.
 *
 * Her kanal için pinlenmiş mesaj listesini tutar.
 * WS event'leri ile gerçek zamanlı güncellenir.
 *
 * State yapısı:
 * - pins: channelId → PinnedMessage[] map'i
 * - isLoading: fetch sırasında true
 *
 * Zustand selector stable ref kuralı:
 * `?? []` kullanmak yerine module-level EMPTY sabit kullanılır.
 * Aksi halde her render'da yeni referans oluşur → infinite re-render.
 */

import { create } from "zustand";
import { getPins, pinMessage, unpinMessage } from "../api/pins";
import type { PinnedMessage } from "../types";

/** Stable boş dizi referansı — selector'larda kullanılır. */
const EMPTY_PINS: PinnedMessage[] = [];

type PinState = {
  /** channelId → PinnedMessage[] */
  pins: Record<string, PinnedMessage[]>;
  isLoading: boolean;

  /** Bir kanalın pinlenmiş mesajlarını backend'den çeker. */
  fetchPins: (channelId: string) => Promise<void>;

  /** Bir mesajı sabitler. */
  pin: (channelId: string, messageId: string) => Promise<boolean>;

  /** Bir mesajın pin'ini kaldırır. */
  unpin: (channelId: string, messageId: string) => Promise<boolean>;

  /** WS event handler: yeni pin geldi. */
  handleMessagePin: (pinned: PinnedMessage) => void;

  /** WS event handler: pin kaldırıldı. */
  handleMessageUnpin: (data: { message_id: string; channel_id: string }) => void;

  /** Bir kanalın pinlerini döner (selector helper). */
  getPinsForChannel: (channelId: string) => PinnedMessage[];

  /** Bir mesajın pinli olup olmadığını kontrol eder. */
  isMessagePinned: (channelId: string, messageId: string) => boolean;
};

export const usePinStore = create<PinState>((set, get) => ({
  pins: {},
  isLoading: false,

  fetchPins: async (channelId) => {
    set({ isLoading: true });
    const res = await getPins(channelId);
    if (res.success && res.data) {
      set((state) => ({
        pins: { ...state.pins, [channelId]: res.data! },
        isLoading: false,
      }));
    } else {
      set({ isLoading: false });
    }
  },

  pin: async (channelId, messageId) => {
    const res = await pinMessage(channelId, messageId);
    // WS event ile güncelleme gelecek — burada ek state güncellemesi gereksiz
    return res.success;
  },

  unpin: async (channelId, messageId) => {
    const res = await unpinMessage(channelId, messageId);
    // WS event ile güncelleme gelecek — burada ek state güncellemesi gereksiz
    return res.success;
  },

  handleMessagePin: (pinned) => {
    set((state) => {
      const channelPins = state.pins[pinned.channel_id] ?? [];
      // Duplikat kontrolü
      if (channelPins.some((p) => p.message_id === pinned.message_id)) {
        return state;
      }
      return {
        pins: {
          ...state.pins,
          [pinned.channel_id]: [pinned, ...channelPins],
        },
      };
    });
  },

  handleMessageUnpin: (data) => {
    set((state) => {
      const channelPins = state.pins[data.channel_id];
      if (!channelPins) return state;
      return {
        pins: {
          ...state.pins,
          [data.channel_id]: channelPins.filter(
            (p) => p.message_id !== data.message_id
          ),
        },
      };
    });
  },

  getPinsForChannel: (channelId) => {
    return get().pins[channelId] ?? EMPTY_PINS;
  },

  isMessagePinned: (channelId, messageId) => {
    const channelPins = get().pins[channelId];
    if (!channelPins) return false;
    return channelPins.some((p) => p.message_id === messageId);
  },
}));
