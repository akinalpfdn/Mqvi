/**
 * Block Store — Kullanıcı engelleme state yönetimi.
 *
 * Tasarım kararları:
 * - blockedUserIds: string[] — engellenen kullanıcı ID'leri.
 *   isBlocked(userId) helper'ı ile O(n) lookup. Küçük liste olacağı
 *   (çoğu kullanıcı <50 block) için yeterli. Set'e gerek yok.
 * - WS event'leri ile gerçek zamanlı güncelleme (user_block, user_unblock)
 * - friendStore ile entegrasyon: block yapıldığında friend listesinden de çıkar
 *
 * Zustand selector stable ref notu:
 * EMPTY_BLOCKED module-level sabit olarak tanımlanır.
 */

import { create } from "zustand";
import i18n from "../i18n";
import * as blockApi from "../api/block";
import { useToastStore } from "./toastStore";
import { useFriendStore } from "./friendStore";
import { useAuthStore } from "./authStore";
import type { FriendshipWithUser } from "../types";

const EMPTY_BLOCKED: string[] = [];

type BlockState = {
  /** Engellenen kullanıcı ID'leri */
  blockedUserIds: string[];
  /** Yüklenme durumu */
  isLoading: boolean;

  // ─── Actions ───

  /** Engellenen kullanıcıları backend'den çek */
  fetchBlocked: () => Promise<void>;
  /** Kullanıcıyı engelle */
  blockUser: (userId: string) => Promise<boolean>;
  /** Engeli kaldır */
  unblockUser: (userId: string) => Promise<boolean>;
  /** Kullanıcının engellenip engellenmediğini kontrol et */
  isBlocked: (userId: string) => boolean;

  // ─── WS Event Handlers ───

  /** user_block event: Bir kullanıcı engellendi */
  handleUserBlock: (data: { user_id: string; blocked_user_id: string }) => void;
  /** user_unblock event: Engel kaldırıldı */
  handleUserUnblock: (data: { user_id: string; unblocked_user_id: string }) => void;
};

export const useBlockStore = create<BlockState>((set, get) => ({
  blockedUserIds: EMPTY_BLOCKED,
  isLoading: false,

  // ─── Actions ───

  fetchBlocked: async () => {
    set({ isLoading: true });
    try {
      const res = await blockApi.listBlocked();
      if (res.success && res.data) {
        // listBlocked → FriendshipWithUser[] döner (status=blocked)
        // Backend blocked listeyi dönerken "user" alanı engellenen kişiyi temsil eder.
        set({ blockedUserIds: res.data.map((f: FriendshipWithUser) => f.user_id) });
      }
    } finally {
      set({ isLoading: false });
    }
  },

  blockUser: async (userId) => {
    const res = await blockApi.blockUser(userId);
    if (res.success) {
      set((s) => ({
        blockedUserIds: [...s.blockedUserIds, userId],
      }));
      // Block yapıldığında arkadaş listesinden de çıkar (backend zaten siliyor)
      useFriendStore.getState().handleFriendRemove({ user_id: userId });
      useToastStore.getState().addToast("success", i18n.t("dm:userBlocked"));
      return true;
    }
    return false;
  },

  unblockUser: async (userId) => {
    const res = await blockApi.unblockUser(userId);
    if (res.success) {
      set((s) => ({
        blockedUserIds: s.blockedUserIds.filter((id) => id !== userId),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:userUnblocked"));
      return true;
    }
    return false;
  },

  isBlocked: (userId) => {
    return get().blockedUserIds.includes(userId);
  },

  // ─── WS Event Handlers ───

  /**
   * handleUserBlock — WS user_block event'i geldiğinde çağrılır.
   *
   * Backend her iki tarafa da broadcast yapar.
   * Kendi bloklamamızsa: listeye ekle + friend listesinden çıkar.
   * Bizi engelledilerse: sadece friend listesinden çıkar.
   */
  handleUserBlock: (data) => {
    const myId = useAuthStore.getState().user?.id;

    if (data.user_id === myId) {
      // Biz engelledik — blocked listesine ekle
      set((s) => {
        if (s.blockedUserIds.includes(data.blocked_user_id)) return s;
        return { blockedUserIds: [...s.blockedUserIds, data.blocked_user_id] };
      });
      // Friend listesinden de çıkar
      useFriendStore.getState().handleFriendRemove({ user_id: data.blocked_user_id });
    } else if (data.blocked_user_id === myId) {
      // Bizi engellediler — friend listesinden çıkar
      useFriendStore.getState().handleFriendRemove({ user_id: data.user_id });
    }
  },

  /**
   * handleUserUnblock — WS user_unblock event'i geldiğinde çağrılır.
   * Kendi unblock'umuzsa listeden çıkar.
   */
  handleUserUnblock: (data) => {
    const myId = useAuthStore.getState().user?.id;

    if (data.user_id === myId) {
      set((s) => ({
        blockedUserIds: s.blockedUserIds.filter((id) => id !== data.unblocked_user_id),
      }));
    }
  },
}));
