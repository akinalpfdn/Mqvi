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
  /** Sunucudaki tüm kanalları okundu olarak işaretle */
  markAllAsRead: (serverId: string) => Promise<boolean>;
};

export const useReadStateStore = create<ReadStateState>((set) => ({
  unreadCounts: {},

  fetchUnreadCounts: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    const res = await readStateApi.getUnreadCounts(serverId);
    if (res.success && res.data) {
      // Backend sonucunu direkt kullan (replace, merge değil).
      //
      // Neden Math.max merge kaldırıldı:
      // Server switch'te clearForServerSwitch → fetchUnreadCounts arasında
      // WS'den gelen incrementUnread çağrıları eski server'ın kanalları için
      // count artırıyordu. Fetch sonucu geldiğinde Math.max(backend=0, local=1)
      // → stale unread kalıyordu. Replace ile fetch sonucu her zaman doğru.
      //
      // incrementUnread race condition: Fetch sırasında gelen yeni mesajlar
      // fetch sonucundan sonraya kadar kaybolabilir mi? Hayır — çünkü
      // backend zaten o mesajı saydı (count'a dahil), veya mesaj
      // fetchUnreadCounts'un backend'e gittiği andan sonra geldi ki bu
      // durumda WS event'i ile incrementUnread zaten çalışacak.
      const counts: Record<string, number> = {};
      for (const info of res.data) {
        counts[info.channel_id] = info.unread_count;
      }
      set({ unreadCounts: counts });
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

  markAllAsRead: async (serverId) => {
    // Önce local'i sıfırla (anında UI güncellemesi)
    set({ unreadCounts: {} });

    // Backend'e bildir
    const res = await readStateApi.markAllRead(serverId);
    return res.success;
  },
}));
