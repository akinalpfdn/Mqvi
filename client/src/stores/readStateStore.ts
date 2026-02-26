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
  /** Mesaj silindiğinde okunmamış sayacını azalt (0'ın altına düşmez) */
  decrementUnread: (channelId: string) => void;
  /** Bir kanalın okunmamış sayısını sıfırla (sadece local) */
  clearUnread: (channelId: string) => void;
};

export const useReadStateStore = create<ReadStateState>((set) => ({
  unreadCounts: {},

  fetchUnreadCounts: async () => {
    const res = await readStateApi.getUnreadCounts();
    if (res.success && res.data) {
      // Backend sayılarını local state ile birleştir (merge).
      // Neden replace yerine merge?
      // fetchUnreadCounts async'tir — API çağrısı sürerken yeni message_create
      // event'i gelip incrementUnread çalışmış olabilir. Düz replace yapılırsa
      // bu local artışlar kaybolur. Merge ile her kanal için MAX(backend, local)
      // alınır — böylece hiçbir okunmamış sayı kaybolmaz.
      set((state) => {
        const merged: Record<string, number> = { ...state.unreadCounts };
        for (const info of res.data!) {
          // Backend'in sayısı local'den büyükse backend'i al,
          // aksi halde local artışı koru
          merged[info.channel_id] = Math.max(
            info.unread_count,
            merged[info.channel_id] ?? 0,
          );
        }
        return { unreadCounts: merged };
      });
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

  decrementUnread: (channelId) => {
    set((state) => {
      const current = state.unreadCounts[channelId] ?? 0;
      if (current <= 0) return state;

      // Sayaç 1 ise tamamen sil (0 tutmak yerine key'i kaldır — badge kaybolsun)
      if (current === 1) {
        const next = { ...state.unreadCounts };
        delete next[channelId];
        return { unreadCounts: next };
      }

      return {
        unreadCounts: {
          ...state.unreadCounts,
          [channelId]: current - 1,
        },
      };
    });
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
