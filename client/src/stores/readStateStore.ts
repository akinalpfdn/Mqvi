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
import { channelMarkRead } from "./shared/markReadTracking";

export type MentionWatermark = { at: string; messageId: string };

/**
 * Leading edge fires at once, then a window coalesces the burst behind it. Without this, a busy
 * channel POSTs once per incoming message: 31 messages in 10s trips the shared read rate limit,
 * and the 429 that follows lands on the DM mark-read too — so the DM watermark stops moving and
 * the phone starts buzzing for the conversation on screen. Must stay well under the server's
 * 3s push delay.
 */
const MARK_READ_COALESCE_MS = 1000;

const { timers: markReadTimers, asked: markReadAsked, sent: markReadSent } = channelMarkRead;

function sendChannelMarkRead(serverId: string, channelId: string, messageId: string): void {
  void readStateApi.markRead(serverId, channelId, messageId).then((res) => {
    if (res.success) {
      markReadSent[channelId] = messageId;
      return;
    }
    // Forget that we asked, or the dedupe guard blocks every retry and the server goes on
    // counting the channel unread with nothing left to correct it.
    delete markReadAsked[channelId];
    delete markReadSent[channelId];
  });
}

type ReadStateState = {
  unreadCounts: Record<string, number>;
  channelServerMap: Record<string, string>;
  /** Tuple watermark per channel — id breaks ties since DATETIME is second-precision */
  lastMentionSeen: Record<string, MentionWatermark>;

  fetchUnreadCounts: (serverId: string) => Promise<void>;
  fetchAllUnreadCounts: () => Promise<void>;
  markAsRead: (channelId: string, lastMessageId: string) => void;
  incrementUnread: (channelId: string) => void;
  decrementUnread: (channelId: string) => void;
  clearUnread: (channelId: string) => void;
  registerChannel: (channelId: string, serverId: string) => void;
  registerChannels: (channelIds: string[], serverId: string) => void;
  getServerUnreadTotal: (serverId: string) => number;
  clearForServerSwitch: () => void;
  markAllAsRead: (serverId: string) => Promise<boolean>;
  markMentionSeen: (channelId: string, messageId: string, messageCreatedAt: string) => void;
  isMentionSeen: (channelId: string, messageId: string, messageCreatedAt: string) => boolean;
};

export const useReadStateStore = create<ReadStateState>((set, get) => ({
  unreadCounts: {},
  channelServerMap: {},
  lastMentionSeen: {},

  fetchUnreadCounts: async (serverId: string) => {
    const res = await readStateApi.getUnreadCounts(serverId);
    if (res.success && res.data) {
      const mutedChannelIds = useChannelStore.getState().mutedChannelIds;
      const mutedServerIds = useServerStore.getState().mutedServerIds;
      const isServerMuted = mutedServerIds.has(serverId);

      set((state) => {
        const nextCounts = { ...state.unreadCounts };
        const nextMap = { ...state.channelServerMap };
        const nextWatermarks = { ...state.lastMentionSeen };

        for (const [chId, sid] of Object.entries(state.channelServerMap)) {
          if (sid === serverId) {
            delete nextCounts[chId];
            delete nextWatermarks[chId];
          }
        }

        for (const info of res.data!) {
          nextMap[info.channel_id] = serverId;
          if (!isServerMuted && !mutedChannelIds.has(info.channel_id)) {
            if (info.unread_count > 0) {
              nextCounts[info.channel_id] = info.unread_count;
            }
          }
          if (info.last_mention_seen_at && info.last_mention_seen_message_id) {
            nextWatermarks[info.channel_id] = {
              at: info.last_mention_seen_at,
              messageId: info.last_mention_seen_message_id,
            };
          }
        }

        return {
          unreadCounts: nextCounts,
          channelServerMap: nextMap,
          lastMentionSeen: nextWatermarks,
        };
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

    if (markReadAsked[channelId] === lastMessageId) return;
    markReadAsked[channelId] = lastMessageId;

    // A window is already open; its trailing edge carries the newest watermark.
    if (markReadTimers[channelId]) return;

    sendChannelMarkRead(serverId, channelId, lastMessageId);
    markReadTimers[channelId] = setTimeout(() => {
      delete markReadTimers[channelId];
      const latest = markReadAsked[channelId];
      if (latest && latest !== markReadSent[channelId]) {
        sendChannelMarkRead(serverId, channelId, latest);
      }
    }, MARK_READ_COALESCE_MS);
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

  markMentionSeen: (channelId, messageId, messageCreatedAt) => {
    const serverId =
      get().channelServerMap[channelId] ??
      useServerStore.getState().activeServerId;

    set((state) => {
      const current = state.lastMentionSeen[channelId];
      if (current) {
        if (current.at > messageCreatedAt) return state;
        if (current.at === messageCreatedAt && current.messageId >= messageId) return state;
      }
      return {
        lastMentionSeen: {
          ...state.lastMentionSeen,
          [channelId]: { at: messageCreatedAt, messageId },
        },
      };
    });

    if (serverId) {
      readStateApi.markMentionSeen(serverId, channelId, messageId);
    }
  },

  isMentionSeen: (channelId, messageId, messageCreatedAt) => {
    const w = get().lastMentionSeen[channelId];
    if (!w) return false;
    if (messageCreatedAt < w.at) return true;
    if (messageCreatedAt === w.at && messageId <= w.messageId) return true;
    return false;
  },
}));
