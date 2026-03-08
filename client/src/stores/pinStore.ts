/**
 * Pin Store — Message pinning state management.
 *
 * Stable empty ref (EMPTY_PINS) prevents infinite re-renders in selectors.
 */

import { create } from "zustand";
import { getPins, pinMessage, unpinMessage } from "../api/pins";
import { useServerStore } from "./serverStore";
import type { PinnedMessage } from "../types";

/** Stable empty ref for selectors */
const EMPTY_PINS: PinnedMessage[] = [];

type PinState = {
  /** channelId -> PinnedMessage[] */
  pins: Record<string, PinnedMessage[]>;
  isLoading: boolean;

  fetchPins: (channelId: string) => Promise<void>;
  pin: (channelId: string, messageId: string) => Promise<boolean>;
  unpin: (channelId: string, messageId: string) => Promise<boolean>;

  // ─── WS Event Handlers ───
  handleMessagePin: (pinned: PinnedMessage) => void;
  handleMessageUnpin: (data: { message_id: string; channel_id: string }) => void;

  getPinsForChannel: (channelId: string) => PinnedMessage[];
  isMessagePinned: (channelId: string, messageId: string) => boolean;
};

export const usePinStore = create<PinState>((set, get) => ({
  pins: {},
  isLoading: false,

  fetchPins: async (channelId) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    set({ isLoading: true });
    const res = await getPins(serverId, channelId);
    if (res.success && res.data) {
      set((state) => ({
        pins: { ...state.pins, [channelId]: res.data! },
        isLoading: false,
      }));
    } else {
      set({ isLoading: false });
    }
  },

  pin: async (channelId, messageId) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;
    const res = await pinMessage(serverId, channelId, messageId);
    // State updated via WS event
    return res.success;
  },

  unpin: async (channelId, messageId) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;
    const res = await unpinMessage(serverId, channelId, messageId);
    return res.success;
  },

  handleMessagePin: (pinned) => {
    set((state) => {
      const channelPins = state.pins[pinned.channel_id] ?? [];
      if (channelPins.some((p) => p.message_id === pinned.message_id)) {
        return state;
      }
      return {
        pins: {
          ...state.pins,
          [pinned.channel_id]: [pinned, ...channelPins],
        },
      };
    });
  },

  handleMessageUnpin: (data) => {
    set((state) => {
      const channelPins = state.pins[data.channel_id];
      if (!channelPins) return state;
      return {
        pins: {
          ...state.pins,
          [data.channel_id]: channelPins.filter(
            (p) => p.message_id !== data.message_id
          ),
        },
      };
    });
  },

  getPinsForChannel: (channelId) => {
    return get().pins[channelId] ?? EMPTY_PINS;
  },

  isMessagePinned: (channelId, messageId) => {
    const channelPins = get().pins[channelId];
    if (!channelPins) return false;
    return channelPins.some((p) => p.message_id === messageId);
  },
}));
