/**
 * Read State Store — Okunmamış mesaj sayısı state yönetimi.
 *
 * Tasarım kararları:
 * - unreadCounts: Record<channelId, number> — her kanalın okunmamış sayısı.
 * - WS message_create geldiğinde, aktif kanal DEĞİLSE sayacı artır.
 * - Kanal değiştirdiğinde (selectChannel) auto-mark-read: sayacı sıfırla + backend'e bildir.
 * - Uygulama başladığında ve reconnect'te fetchUnreadCounts çağrılır.
 *
 * Zustand selector stable ref notu:
 * `getUnreadCount(channelId)` selector'ı primitif (number) döndüğü için
 * referans eşitliği sorunu yok (number === number).
 */

import { create } from "zustand";
import * as readStateApi from "../api/readState";

type ReadStateState = {
  /** Kanal bazlı okunmamış mesaj sayıları: channelId → count */
  unreadCounts: Record<string, number>;

  // ─── Actions ───
  /** Backend'den tüm okunmamış sayıları çek (uygulama başlatma / reconnect) */
  fetchUnreadCounts: () => Promise<void>;
  /** Bir kanalı okundu olarak işaretle (sayacı sıfırla + backend'e bildir) */
  markAsRead: (channelId: string, lastMessageId: string) => void;
  /** Yeni mesaj geldiğinde okunmamış sayacını artır (aktif kanal değilse) */
  incrementUnread: (channelId: string) => void;
  /** Bir kanalın okunmamış sayısını sıfırla (sadece local) */
  clearUnread: (channelId: string) => void;
};

export const useReadStateStore = create<ReadStateState>((set) => ({
  unreadCounts: {},

  fetchUnreadCounts: async () => {
    const res = await readStateApi.getUnreadCounts();
    if (res.success && res.data) {
      const counts: Record<string, number> = {};
      for (const info of res.data) {
        counts[info.channel_id] = info.unread_count;
      }
      set({ unreadCounts: counts });
    }
  },

  markAsRead: (channelId, lastMessageId) => {
    // Önce local'i sıfırla (anında UI güncellemesi)
    set((state) => {
      if (!state.unreadCounts[channelId]) return state;
      const next = { ...state.unreadCounts };
      delete next[channelId];
      return { unreadCounts: next };
    });

    // Backend'e bildir (fire-and-forget — hata olsa bile UI'da badge kaybolmuş olur)
    readStateApi.markRead(channelId, lastMessageId);
  },

  incrementUnread: (channelId) => {
    set((state) => ({
      unreadCounts: {
        ...state.unreadCounts,
        [channelId]: (state.unreadCounts[channelId] ?? 0) + 1,
      },
    }));
  },

  clearUnread: (channelId) => {
    set((state) => {
      if (!state.unreadCounts[channelId]) return state;
      const next = { ...state.unreadCounts };
      delete next[channelId];
      return { unreadCounts: next };
    });
  },
}));
