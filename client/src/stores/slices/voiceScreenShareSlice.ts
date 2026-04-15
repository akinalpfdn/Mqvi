/**
 * voiceScreenShareSlice — screen share watch/focus state.
 *
 * Watch state is intentionally not persisted: subscriptions are per-session,
 * opt-in per click to avoid unnecessary bandwidth on join.
 */

import type { StateCreator } from "zustand";
import { playJoinSound, playLeaveSound } from "../../utils/sounds";
import type { VoiceStore } from "../voiceStore";

export type VoiceScreenShareSlice = {
  /** streamer user IDs we're actively subscribed to */
  watchingScreenShares: Record<string, boolean>;
  /** streamerUserID -> viewer count (maintained via WS events) */
  screenShareViewers: Record<string, number>;

  toggleWatchScreenShare: (userId: string) => void;
  focusScreenShare: (userId: string) => void;
};

export const createVoiceScreenShareSlice: StateCreator<
  VoiceStore,
  [],
  [],
  VoiceScreenShareSlice
> = (set, get) => ({
  watchingScreenShares: {},
  screenShareViewers: {},

  toggleWatchScreenShare: (userId: string) => {
    const { watchingScreenShares, _wsSend } = get();
    const isWatching = watchingScreenShares[userId] ?? false;

    if (isWatching) {
      const next = { ...watchingScreenShares };
      delete next[userId];
      set({ watchingScreenShares: next });
      playLeaveSound();
    } else {
      set({ watchingScreenShares: { ...watchingScreenShares, [userId]: true } });
      playJoinSound();
    }

    if (_wsSend) {
      _wsSend("screen_share_watch", {
        streamer_user_id: userId,
        watching: !isWatching,
      });
    }
  },

  focusScreenShare: (userId: string) => {
    const { watchingScreenShares, _wsSend } = get();
    const watchingIds = Object.keys(watchingScreenShares);

    if (watchingIds.length === 1 && watchingScreenShares[userId]) return;

    if (_wsSend) {
      for (const id of watchingIds) {
        if (id !== userId) {
          _wsSend("screen_share_watch", { streamer_user_id: id, watching: false });
        }
      }
      if (!watchingScreenShares[userId]) {
        _wsSend("screen_share_watch", { streamer_user_id: userId, watching: true });
      }
    }

    set({ watchingScreenShares: { [userId]: true } });
    playLeaveSound();
  },
});
