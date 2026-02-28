/**
 * Read State Store — Okunmamış mesaj sayısı state yönetimi.
 *
 * Multi-server: fetchUnreadCounts activeServerId'ye göre server-scoped.
 * markAsRead de serverId gerektirir.
 *
 * Tasarım kararları:
 * - unreadCounts: Record<channelId, number> — her kanalın okunmamış sayısı.
 * - WS message_create geldiğinde, aktif kanal DEĞİLSE sayacı artır.
 * - Kanal değiştirdiğinde (selectChannel) auto-mark-read: sayacı sıfırla + backend'e bildir.
 * - Uygulama başladığında ve reconnect'te fetchUnreadCounts çağrılır.
 */

import { create } from "zustand";
import * as readStateApi from "../api/readState";
import { useServerStore } from "./serverStore";

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
  /** Server değiştirildiğinde store'u temizler */
  clearForServerSwitch: () => void;
};

export const useReadStateStore = create<ReadStateState>((set) => ({
  unreadCounts: {},

  fetchUnreadCounts: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    const res = await readStateApi.getUnreadCounts(serverId);
    if (res.success && res.data) {
      // Backend sayılarını local state ile birleştir (merge).
      set((state) => {
        const merged: Record<string, number> = { ...state.unreadCounts };
        for (const info of res.data!) {
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
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    // Önce local'i sıfırla (anında UI güncellemesi)
    set((state) => {
      if (!state.unreadCounts[channelId]) return state;
      const next = { ...state.unreadCounts };
      delete next[channelId];
      return { unreadCounts: next };
    });

    // Backend'e bildir (fire-and-forget)
    readStateApi.markRead(serverId, channelId, lastMessageId);
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

  clearForServerSwitch: () => {
    set({ unreadCounts: {} });
  },
}));
