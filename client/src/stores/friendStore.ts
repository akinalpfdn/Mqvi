/**
 * Friend Store — Friendship system state management.
 *
 * Stable empty refs (EMPTY_*) prevent infinite re-renders in selectors.
 */

import { create } from "zustand";
import * as friendsApi from "../api/friends";
import type { FriendshipWithUser } from "../types";

const EMPTY_FRIENDS: FriendshipWithUser[] = [];
const EMPTY_INCOMING: FriendshipWithUser[] = [];
const EMPTY_OUTGOING: FriendshipWithUser[] = [];

type FriendState = {
  friends: FriendshipWithUser[];
  incoming: FriendshipWithUser[];
  outgoing: FriendshipWithUser[];
  isLoading: boolean;

  // ─── Actions ───
  fetchFriends: () => Promise<void>;
  fetchRequests: () => Promise<void>;
  sendRequest: (username: string) => Promise<{ success: boolean; error?: string }>;
  acceptRequest: (requestId: string) => Promise<boolean>;
  declineRequest: (requestId: string) => Promise<boolean>;
  removeFriend: (userId: string) => Promise<boolean>;

  // ─── WS Event Handlers ───
  handleFriendRequestCreate: (data: FriendshipWithUser) => void;
  handleFriendRequestAccept: (data: FriendshipWithUser) => void;
  handleFriendRequestDecline: (data: { id: string; user_id: string }) => void;
  handleFriendRemove: (data: { user_id: string }) => void;
};

export const useFriendStore = create<FriendState>((set, get) => ({
  friends: EMPTY_FRIENDS,
  incoming: EMPTY_INCOMING,
  outgoing: EMPTY_OUTGOING,
  isLoading: false,

  // ─── Actions ───

  fetchFriends: async () => {
    set({ isLoading: true });
    try {
      const res = await friendsApi.listFriends();
      if (res.success && res.data) {
        set({ friends: res.data });
      }
    } finally {
      set({ isLoading: false });
    }
  },

  fetchRequests: async () => {
    try {
      const res = await friendsApi.listRequests();
      if (res.success && res.data) {
        set({
          incoming: res.data.incoming,
          outgoing: res.data.outgoing,
        });
      }
    } catch {
      // Silent — toast is handler's responsibility
    }
  },

  sendRequest: async (username: string) => {
    const res = await friendsApi.sendRequest(username);
    if (res.success && res.data) {
      if (res.data.status === "accepted") {
        set((s) => ({ friends: [res.data!, ...s.friends] }));
      } else {
        set((s) => ({ outgoing: [res.data!, ...s.outgoing] }));
      }
      return { success: true };
    }
    return { success: false, error: res.error };
  },

  acceptRequest: async (requestId: string) => {
    const res = await friendsApi.acceptRequest(requestId);
    if (res.success && res.data) {
      set((s) => ({
        incoming: s.incoming.filter((r) => r.id !== requestId),
        friends: [res.data!, ...s.friends],
      }));
      return true;
    }
    return false;
  },

  declineRequest: async (requestId: string) => {
    const res = await friendsApi.declineRequest(requestId);
    if (res.success) {
      set((s) => ({
        // Remove from both lists (user could be on either side)
        incoming: s.incoming.filter((r) => r.id !== requestId),
        outgoing: s.outgoing.filter((r) => r.id !== requestId),
      }));
      return true;
    }
    return false;
  },

  removeFriend: async (userId: string) => {
    const res = await friendsApi.removeFriend(userId);
    if (res.success) {
      set((s) => ({
        friends: s.friends.filter((f) => f.user_id !== userId),
      }));
      return true;
    }
    return false;
  },

  // ─── WS Event Handlers ───

  handleFriendRequestCreate: (data: FriendshipWithUser) => {
    set((s) => ({
      incoming: [data, ...s.incoming],
    }));
  },

  handleFriendRequestAccept: (data: FriendshipWithUser) => {
    const { outgoing } = get();
    set({
      outgoing: outgoing.filter((r) => r.id !== data.id),
      friends: [data, ...get().friends],
    });
  },

  handleFriendRequestDecline: (data: { id: string; user_id: string }) => {
    set((s) => ({
      incoming: s.incoming.filter((r) => r.id !== data.id),
      outgoing: s.outgoing.filter((r) => r.id !== data.id),
    }));
  },

  handleFriendRemove: (data: { user_id: string }) => {
    set((s) => ({
      friends: s.friends.filter((f) => f.user_id !== data.user_id),
    }));
  },
}));
