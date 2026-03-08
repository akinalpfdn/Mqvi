/**
 * Read State Store — Unread message count management.
 */

import { create } from "zustand";
import * as readStateApi from "../api/readState";
import { useServerStore } from "./serverStore";
import { useChannelStore } from "./channelStore";

type ReadStateState = {
  /** channelId -> unread count */
  unreadCounts: Record<string, number>;

  fetchUnreadCounts: () => Promise<void>;
  markAsRead: (channelId: string, lastMessageId: string) => void;
  incrementUnread: (channelId: string) => void;
  decrementUnread: (channelId: string) => void;
  clearUnread: (channelId: string) => void;
  clearForServerSwitch: () => void;
  markAllAsRead: (serverId: string) => Promise<boolean>;
};

export const useReadStateStore = create<ReadStateState>((set) => ({
  unreadCounts: {},

  fetchUnreadCounts: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    const res = await readStateApi.getUnreadCounts(serverId);
    if (res.success && res.data) {
      // Direct replace (not merge). Math.max merge was removed because
      // increments from a previous server could leak into the new server's
      // counts between clearForServerSwitch and fetch completion.
      const mutedChannelIds = useChannelStore.getState().mutedChannelIds;
      const mutedServerIds = useServerStore.getState().mutedServerIds;
      const activeServerId = useServerStore.getState().activeServerId;
      const isServerMuted = activeServerId ? mutedServerIds.has(activeServerId) : false;

      const counts: Record<string, number> = {};
      for (const info of res.data) {
        if (isServerMuted) continue;
        if (mutedChannelIds.has(info.channel_id)) continue;
        counts[info.channel_id] = info.unread_count;
      }
      set({ unreadCounts: counts });
    }
  },

  markAsRead: (channelId, lastMessageId) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    // Clear local first for instant UI update
    set((state) => {
      if (!state.unreadCounts[channelId]) return state;
      const next = { ...state.unreadCounts };
      delete next[channelId];
      return { unreadCounts: next };
    });

    // Fire-and-forget to backend
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
    set({ unreadCounts: {} });
    const res = await readStateApi.markAllRead(serverId);
    return res.success;
  },
}));
