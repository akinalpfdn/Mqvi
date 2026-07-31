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
 * Per-server bookkeeping for the unread snapshot. `gen` retires a superseded request, `raced`
 * records that a local change landed while the request was in flight.
 */
type UnreadFetchState = { gen: number; raced: boolean; refetches: number };

/** A snapshot that keeps racing local events must not re-fetch forever. */
const MAX_UNREAD_REFETCHES = 3;

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
  /** serverId -> in-flight snapshot bookkeeping. See fetchUnreadCounts. */
  _unreadFetch: Record<string, UnreadFetchState>;

  /** A local unread change happened; any snapshot in flight for that server is now suspect. */
  noteUnreadRaced: (channelId: string) => void;

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
  _unreadFetch: {},

  noteUnreadRaced: (channelId) => {
    const serverId = get().channelServerMap[channelId];
    set((state) => {
      const next: Record<string, UnreadFetchState> = {};
      for (const [sid, tracked] of Object.entries(state._unreadFetch)) {
        // An unmapped channel cannot be attributed to a server, so no snapshot in flight can be
        // trusted to already include it.
        next[sid] = !serverId || sid === serverId ? { ...tracked, raced: true } : tracked;
      }
      return { _unreadFetch: next };
    });
  },

  /**
   * Replaces this server's slice of the unread state with the server's snapshot.
   *
   * The snapshot is a bare per-channel count. It cannot say whether it was taken before or after
   * an event that arrived while it was in flight, and guessing either way is wrong: adding on top
   * double-counts, taking it verbatim drops the badge for a message that really did arrive. So a
   * raced snapshot is thrown away and a fresh one taken from after the events, bounded so a busy
   * channel cannot spin here forever. Same rule the DM list follows.
   */
  fetchUnreadCounts: async (serverId: string) => {
    const gen = (get()._unreadFetch[serverId]?.gen ?? 0) + 1;
    set((state) => ({
      _unreadFetch: {
        ...state._unreadFetch,
        [serverId]: {
          gen,
          raced: false,
          refetches: state._unreadFetch[serverId]?.refetches ?? 0,
        },
      },
    }));

    const res = await readStateApi.getUnreadCounts(serverId);

    // A newer fetch for this server already superseded us; its answer is the fresher truth.
    if (get()._unreadFetch[serverId]?.gen !== gen) return;

    // The request failed. "It did not say" is not "everything is read" — keep the badges.
    if (!res.success || !res.data) {
      set((state) => ({
        _unreadFetch: {
          ...state._unreadFetch,
          [serverId]: { gen, raced: false, refetches: 0 },
        },
      }));
      return;
    }

    if (get()._unreadFetch[serverId]?.raced) {
      const spent = get()._unreadFetch[serverId]?.refetches ?? 0;
      if (spent < MAX_UNREAD_REFETCHES) {
        set((state) => ({
          _unreadFetch: {
            ...state._unreadFetch,
            [serverId]: { gen, raced: false, refetches: spent + 1 },
          },
        }));
        void get().fetchUnreadCounts(serverId);
        return;
      }
    }

    {
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
          _unreadFetch: {
            ...state._unreadFetch,
            [serverId]: { gen, raced: false, refetches: 0 },
          },
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

    // Only an actual change can be undone by a stale snapshot. Marking a channel read that had no
    // badge changes nothing — noting a race there would cost a re-fetch per server on every
    // reconnect, because resync marks the open channel read whether or not anything arrived.
    if (get().unreadCounts[channelId]) get().noteUnreadRaced(channelId);

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
    get().noteUnreadRaced(channelId);
    set((state) => ({
      unreadCounts: {
        ...state.unreadCounts,
        [channelId]: (state.unreadCounts[channelId] ?? 0) + 1,
      },
    }));
  },

  decrementUnread: (channelId) => {
    if ((get().unreadCounts[channelId] ?? 0) > 0) get().noteUnreadRaced(channelId);
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
    if (get().unreadCounts[channelId]) get().noteUnreadRaced(channelId);
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
      let cleared = false;
      for (const [chId, sid] of Object.entries(state.channelServerMap)) {
        if (sid === serverId && nextCounts[chId]) {
          delete nextCounts[chId];
          cleared = true;
        }
      }
      const tracked = state._unreadFetch[serverId];
      return {
        unreadCounts: nextCounts,
        // Server-wide clear — a snapshot taken before it is stale for every channel here. Only
        // when something was actually cleared; otherwise nothing can be undone.
        _unreadFetch: cleared && tracked
          ? { ...state._unreadFetch, [serverId]: { ...tracked, raced: true } }
          : state._unreadFetch,
      };
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
