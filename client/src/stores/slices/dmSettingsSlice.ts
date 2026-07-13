import type { StateCreator } from "zustand";
import i18n from "../../i18n";
import * as dmApi from "../../api/dm";
import { useToastStore } from "../toastStore";
import { sortChannelsByActivity } from "../shared/dmSort";
import { dismissNotificationsFor, dismissReadNotifications } from "../../utils/pushDismiss";
import type { DMStore } from "../dmStore";

export type DMSettingsSlice = {
  dmUnreadCounts: Record<string, number>;
  pendingSearchChannelId: string | null;

  /**
   * The server owns unread now, so a snapshot of it replaces what we hold — otherwise a
   * conversation read on another device would keep its badge here forever. But a snapshot
   * is stale the moment it is requested: a message arriving while it is in flight is not
   * in it. These two fields hold those arrivals so they can be added back on top instead
   * of being erased. See applyServerUnread.
   */
  _unreadFetchInFlight: boolean;
  _unreadSinceFetch: Record<string, number>;
  /** Called by fetchChannels around its request. */
  beginUnreadFetch: () => void;
  applyServerUnread: (counts: Record<string, number>) => void;

  /** A conversation was read on another device — the server tells us where it now stands. */
  handleDMRead: (data: { dm_channel_id: string; unread_count: number }) => void;

  hideDM: (channelId: string) => Promise<void>;
  pinDM: (channelId: string) => Promise<void>;
  unpinDM: (channelId: string) => Promise<void>;
  muteDM: (channelId: string, duration: string) => Promise<void>;
  unmuteDM: (channelId: string) => Promise<void>;
  fetchDMSettings: () => Promise<void>;
  setPendingSearchChannelId: (id: string | null) => void;

  incrementDMUnread: (channelId: string) => void;
  decrementDMUnread: (channelId: string) => void;
  clearDMUnread: (channelId: string) => void;
  getTotalDMUnread: () => number;
};

export const createDMSettingsSlice: StateCreator<
  DMStore,
  [],
  [],
  DMSettingsSlice
> = (set, get) => ({
  dmUnreadCounts: {},
  pendingSearchChannelId: null,
  _unreadFetchInFlight: false,
  _unreadSinceFetch: {},

  beginUnreadFetch: () => set({ _unreadFetchInFlight: true, _unreadSinceFetch: {} }),

  applyServerUnread: (counts) => {
    set((state) => {
      const merged = { ...counts };
      // Messages that landed while the snapshot was in flight aren't in it — add them back.
      for (const [channelId, n] of Object.entries(state._unreadSinceFetch)) {
        merged[channelId] = (merged[channelId] ?? 0) + n;
      }
      // A device that was asleep or killed missed both the dm_read event and its retraction
      // push, so it can come back still showing notifications for conversations read long ago.
      void dismissReadNotifications(new Set(Object.keys(merged)));
      return {
        dmUnreadCounts: merged,
        _unreadFetchInFlight: false,
        _unreadSinceFetch: {},
      };
    });
  },

  handleDMRead: ({ dm_channel_id, unread_count }) => {
    if (unread_count === 0) void dismissNotificationsFor(dm_channel_id);

    set((state) => {
      const next = { ...state.dmUnreadCounts };
      if (unread_count > 0) next[dm_channel_id] = unread_count;
      else delete next[dm_channel_id];

      // Don't let an in-flight snapshot add this conversation's messages back.
      const since = { ...state._unreadSinceFetch };
      delete since[dm_channel_id];

      return { dmUnreadCounts: next, _unreadSinceFetch: since };
    });
  },

  hideDM: async (channelId) => {
    const res = await dmApi.hideDM(channelId);
    if (res.success) {
      set((state) => ({
        channels: state.channels.filter((ch) => ch.id !== channelId),
        selectedDMId: state.selectedDMId === channelId ? null : state.selectedDMId,
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmClosed"));
    }
  },

  pinDM: async (channelId) => {
    const res = await dmApi.pinDMConversation(channelId);
    if (res.success) {
      set((state) => ({
        channels: sortChannelsByActivity(
          state.channels.map((ch) =>
            ch.id === channelId ? { ...ch, is_pinned: true } : ch
          )
        ),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmPinned"));
    }
  },

  unpinDM: async (channelId) => {
    const res = await dmApi.unpinDMConversation(channelId);
    if (res.success) {
      set((state) => ({
        channels: sortChannelsByActivity(
          state.channels.map((ch) =>
            ch.id === channelId ? { ...ch, is_pinned: false } : ch
          )
        ),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmUnpinned"));
    }
  },

  muteDM: async (channelId, duration) => {
    const res = await dmApi.muteDM(channelId, duration);
    if (res.success) {
      set((state) => ({
        channels: state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, is_muted: true } : ch
        ),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmMuted"));
    }
  },

  unmuteDM: async (channelId) => {
    const res = await dmApi.unmuteDM(channelId);
    if (res.success) {
      set((state) => ({
        channels: state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, is_muted: false } : ch
        ),
      }));
      useToastStore.getState().addToast("success", i18n.t("dm:dmUnmuted"));
    }
  },

  fetchDMSettings: async () => {
    const res = await dmApi.getDMSettings();
    if (res.success && res.data) {
      const pinnedSet = new Set(res.data.pinned_channel_ids ?? []);
      const mutedSet = new Set(res.data.muted_channel_ids ?? []);
      set((state) => ({
        channels: sortChannelsByActivity(
          state.channels.map((ch) => ({
            ...ch,
            is_pinned: pinnedSet.has(ch.id),
            is_muted: mutedSet.has(ch.id),
          }))
        ),
      }));
    }
  },

  setPendingSearchChannelId: (id) => set({ pendingSearchChannelId: id }),

  incrementDMUnread: (channelId) => {
    set((state) => ({
      dmUnreadCounts: {
        ...state.dmUnreadCounts,
        [channelId]: (state.dmUnreadCounts[channelId] ?? 0) + 1,
      },
      // Remember it separately while a server snapshot is in flight — that snapshot predates
      // this message, and applying it verbatim would drop the badge we just raised.
      _unreadSinceFetch: state._unreadFetchInFlight
        ? {
            ...state._unreadSinceFetch,
            [channelId]: (state._unreadSinceFetch[channelId] ?? 0) + 1,
          }
        : state._unreadSinceFetch,
    }));
  },

  decrementDMUnread: (channelId) => {
    set((state) => {
      const current = state.dmUnreadCounts[channelId] ?? 0;
      if (current <= 0) return state;

      if (current === 1) {
        const next = { ...state.dmUnreadCounts };
        delete next[channelId];
        return { dmUnreadCounts: next };
      }

      return {
        dmUnreadCounts: {
          ...state.dmUnreadCounts,
          [channelId]: current - 1,
        },
      };
    });
  },

  clearDMUnread: (channelId) => {
    // Reading the conversation retires its tray notification too, whichever device raised it.
    void dismissNotificationsFor(channelId);

    // Persist it: this is what clears the badge on the user's other devices and retracts
    // the notification they were already shown. The newest message we have is the
    // watermark; with none loaded the server marks the whole conversation read.
    const messages = get().messagesByChannel[channelId];
    const lastId = messages?.[messages.length - 1]?.id;
    void dmApi.markDMRead(channelId, lastId).then((res) => {
      if (!res.success) console.error("[dm] failed to persist read state:", res.error);
    });

    set((state) => {
      const next = { ...state.dmUnreadCounts };
      delete next[channelId];
      const since = { ...state._unreadSinceFetch };
      delete since[channelId];
      return { dmUnreadCounts: next, _unreadSinceFetch: since };
    });
  },

  getTotalDMUnread: () => {
    const counts = get().dmUnreadCounts;
    return Object.values(counts).reduce((sum, c) => sum + c, 0);
  },
});
