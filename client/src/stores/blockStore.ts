/**
 * Block Store — User blocking state management.
 */

import { create } from "zustand";
import i18n from "../i18n";
import * as blockApi from "../api/block";
import { useToastStore } from "./toastStore";
import { useFriendStore } from "./friendStore";
import { useAuthStore } from "./authStore";
import type { FriendshipWithUser } from "../types";

/** Stable empty ref to prevent infinite re-renders in selectors */
const EMPTY_BLOCKED: string[] = [];

type BlockState = {
  blockedUserIds: string[];
  isLoading: boolean;

  fetchBlocked: () => Promise<void>;
  blockUser: (userId: string) => Promise<boolean>;
  unblockUser: (userId: string) => Promise<boolean>;
  isBlocked: (userId: string) => boolean;

  // ─── WS Event Handlers ───
  handleUserBlock: (data: { user_id: string; blocked_user_id: string }) => void;
  handleUserUnblock: (data: { user_id: string; unblocked_user_id: string }) => void;
};

export const useBlockStore = create<BlockState>((set, get) => ({
  blockedUserIds: EMPTY_BLOCKED,
  isLoading: false,

  fetchBlocked: async () => {
    set({ isLoading: true });
    try {
      const res = await blockApi.listBlocked();
      if (res.success && res.data) {
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
      // Backend already removes friendship
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
   * Backend broadcasts to both parties.
   * If we blocked: add to list + remove from friends.
   * If they blocked us: just remove from friends.
   */
  handleUserBlock: (data) => {
    const myId = useAuthStore.getState().user?.id;

    if (data.user_id === myId) {
      set((s) => {
        if (s.blockedUserIds.includes(data.blocked_user_id)) return s;
        return { blockedUserIds: [...s.blockedUserIds, data.blocked_user_id] };
      });
      useFriendStore.getState().handleFriendRemove({ user_id: data.blocked_user_id });
    } else if (data.blocked_user_id === myId) {
      useFriendStore.getState().handleFriendRemove({ user_id: data.user_id });
    }
  },

  handleUserUnblock: (data) => {
    const myId = useAuthStore.getState().user?.id;

    if (data.user_id === myId) {
      set((s) => ({
        blockedUserIds: s.blockedUserIds.filter((id) => id !== data.unblocked_user_id),
      }));
    }
  },
}));
