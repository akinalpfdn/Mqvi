/**
 * Read State Store — Global unread message count management.
 *
 * Tracks unread counts across ALL servers simultaneously so that
 * cross-server notifications and per-server badges work correctly.
 * channelServerMap maintains channelId→serverId mapping for aggregation.
 */

import { create } from "zustand";
import * as readStateApi from "../api/readState";
import { useServerStore } from "./serverStore";
import { useChannelStore } from "./channelStore";

type ReadStateState = {
  /** channelId -> unread count (global, not per-server) */
  unreadCounts: Record<string, number>;
  /** channelId -> serverId mapping for per-server aggregation */
  channelServerMap: Record<string, string>;
  /** channelId -> set of mention message IDs the user has already seen */
  seenMentions: Record<string, Set<string>>;

  /** Fetch unread counts for a specific server and merge into global state */
  fetchUnreadCounts: (serverId: string) => Promise<void>;
  /** Fetch unread counts for ALL servers the user belongs to */
  fetchAllUnreadCounts: () => Promise<void>;
  markAsRead: (channelId: string, lastMessageId: string) => void;
  incrementUnread: (channelId: string) => void;
  decrementUnread: (channelId: string) => void;
  clearUnread: (channelId: string) => void;
  /** Register channelId → serverId mapping (called when messages arrive) */
  registerChannel: (channelId: string, serverId: string) => void;
  /** Register multiple channels for a server (called when channels are fetched) */
  registerChannels: (channelIds: string[], serverId: string) => void;
  /** Get total unread count for a specific server */
  getServerUnreadTotal: (serverId: string) => number;
  /** Clear only the active server's unread data (for server switch refetch) */
  clearForServerSwitch: () => void;
  markAllAsRead: (serverId: string) => Promise<boolean>;
  /** Mark a mention message as seen (survives channel switches) */
  markMentionSeen: (channelId: string, messageId: string) => void;
  /** Check if a mention message has been seen */
  isMentionSeen: (channelId: string, messageId: string) => boolean;
};

export const useReadStateStore = create<ReadStateState>((set, get) => ({
  unreadCounts: {},
  channelServerMap: {},
  seenMentions: {},

  fetchUnreadCounts: async (serverId: string) => {
    const res = await readStateApi.getUnreadCounts(serverId);
    if (res.success && res.data) {
      const mutedChannelIds = useChannelStore.getState().mutedChannelIds;
      const mutedServerIds = useServerStore.getState().mutedServerIds;
      const isServerMuted = mutedServerIds.has(serverId);

      set((state) => {
        // Clear old entries belonging to this server, then add fresh ones
        const nextCounts = { ...state.unreadCounts };
        const nextMap = { ...state.channelServerMap };

        // Remove stale entries for this server
        for (const [chId, sid] of Object.entries(state.channelServerMap)) {
          if (sid === serverId) {
            delete nextCounts[chId];
          }
        }

        // Add fresh counts (skip muted)
        for (const info of res.data!) {
          nextMap[info.channel_id] = serverId;
          if (!isServerMuted && !mutedChannelIds.has(info.channel_id)) {
            nextCounts[info.channel_id] = info.unread_count;
          }
        }

        return { unreadCounts: nextCounts, channelServerMap: nextMap };
      });
    }
  },

  fetchAllUnreadCounts: async () => {
    const servers = useServerStore.getState().servers;
    // Fetch in parallel for all servers
    await Promise.all(servers.map((srv) => get().fetchUnreadCounts(srv.id)));
  },

  markAsRead: (channelId, lastMessageId) => {
    // Look up serverId from the mapping
    const serverId =
      get().channelServerMap[channelId] ??
      useServerStore.getState().activeServerId;
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

  registerChannel: (channelId, serverId) => {
    set((state) => {
      if (state.channelServerMap[channelId] === serverId) return state;
      return {
        channelServerMap: { ...state.channelServerMap, [channelId]: serverId },
      };
    });
  },

  registerChannels: (channelIds, serverId) => {
    set((state) => {
      let changed = false;
      const nextMap = { ...state.channelServerMap };
      for (const chId of channelIds) {
        if (nextMap[chId] !== serverId) {
          nextMap[chId] = serverId;
          changed = true;
        }
      }
      return changed ? { channelServerMap: nextMap } : state;
    });
  },

  getServerUnreadTotal: (serverId) => {
    const { unreadCounts, channelServerMap } = get();
    const mutedChannelIds = useChannelStore.getState().mutedChannelIds;
    let total = 0;
    for (const [chId, count] of Object.entries(unreadCounts)) {
      if (channelServerMap[chId] === serverId && !mutedChannelIds.has(chId)) {
        total += count;
      }
    }
    return total;
  },

  clearForServerSwitch: () => {
    // No-op: unread counts are now global. Server-specific data is refreshed
    // by fetchUnreadCounts(serverId) which replaces that server's entries.
  },

  markAllAsRead: async (serverId) => {
    // Clear only this server's counts locally
    set((state) => {
      const nextCounts = { ...state.unreadCounts };
      for (const [chId, sid] of Object.entries(state.channelServerMap)) {
        if (sid === serverId) {
          delete nextCounts[chId];
        }
      }
      return { unreadCounts: nextCounts };
    });

    const res = await readStateApi.markAllRead(serverId);
    return res.success;
  },

  markMentionSeen: (channelId, messageId) => {
    set((state) => {
      const existing = state.seenMentions[channelId];
      if (existing?.has(messageId)) return state;
      const next = new Set(existing);
      next.add(messageId);
      return { seenMentions: { ...state.seenMentions, [channelId]: next } };
    });
  },

  isMentionSeen: (channelId, messageId) => {
    return get().seenMentions[channelId]?.has(messageId) ?? false;
  },
}));
