import type { StateCreator } from "zustand";
import i18n from "../../i18n";
import * as dmApi from "../../api/dm";
import { useToastStore } from "../toastStore";
import { sortChannelsByActivity } from "../shared/dmSort";
import type { DMStore } from "../dmStore";

export type DMSettingsSlice = {
  dmUnreadCounts: Record<string, number>;
  pendingSearchChannelId: string | null;

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
    set((state) => {
      if (!state.dmUnreadCounts[channelId]) return state;
      const next = { ...state.dmUnreadCounts };
      delete next[channelId];
      return { dmUnreadCounts: next };
    });
  },

  getTotalDMUnread: () => {
    const counts = get().dmUnreadCounts;
    return Object.values(counts).reduce((sum, c) => sum + c, 0);
  },
});
