import type { StateCreator } from "zustand";
import i18n from "../../i18n";
import * as dmApi from "../../api/dm";
import { useToastStore } from "../toastStore";
import { useE2EEStore } from "../e2eeStore";
import { sortChannelsByActivity } from "../shared/dmSort";
import { dismissNotificationsFor, dismissReadNotifications } from "../../utils/pushDismiss";
import { dmMarkRead } from "../shared/markReadTracking";
import type { DMStore } from "../dmStore";
import type { DMMessage } from "../../types";

/** Leading-edge immediate, then coalesce. Must stay well under the server's push delay (3s). */
const MARK_READ_COALESCE_MS = 1000;
/** A snapshot that keeps racing local events must not re-fetch forever. */
const MAX_UNREAD_REFETCHES = 3;

/**
 * A message the user could actually read. An encrypted message that failed to decrypt renders
 * as a placeholder, so claiming to have read it would retract the push from the one device that
 * might still decrypt it. Plaintext (v0) and empty-but-attached messages are readable.
 */
function isReadable(m: DMMessage): boolean {
  return m.encryption_version !== 1 || m.content !== null;
}

/** The newest message we hold that the user could actually see, or undefined if there is none. */
function readableWatermark(messages: DMMessage[] | undefined): DMMessage | undefined {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isReadable(messages[i])) return messages[i];
  }
  return undefined;
}

const { timers: markReadTimers, asked: markReadAsked, sent: markReadSent } = dmMarkRead;

function sendMarkRead(channelId: string, messageId: string | undefined): void {
  void dmApi.markDMRead(channelId, messageId).then((res) => {
    if (res.success) {
      if (messageId) markReadSent[channelId] = messageId;
      return;
    }
    // Forget that we asked. Otherwise the dedupe guard would block every retry, the server would
    // go on counting the conversation unread, and the badge it paints back on the next snapshot
    // would have nothing left to clear it.
    console.error("[dm] failed to persist read state:", res.error);
    delete markReadAsked[channelId];
    delete markReadSent[channelId];
  });
}

/** Drop the badge and retire the tray notification, whichever device raised it. */
function clearLocalUnread(
  set: (fn: (s: DMStore) => Partial<DMStore>) => void,
  get: () => DMStore,
  channelId: string
): void {
  void dismissNotificationsFor(channelId);
  get().noteUnreadRaced();
  set((state) => {
    const next = { ...state.dmUnreadCounts };
    delete next[channelId];
    return { dmUnreadCounts: next };
  });
}

export type DMSettingsSlice = {
  dmUnreadCounts: Record<string, number>;
  pendingSearchChannelId: string | null;

  /**
   * The server owns unread, so its snapshot replaces what we hold — otherwise a conversation
   * read on another device would keep its badge here forever. But a snapshot is already stale
   * when it lands: a message or a read that raced it is not in it, and there is no way to tell
   * from a bare count whether it is or not. So we do not try to patch the snapshot up — we
   * notice that it raced and ask again. A later snapshot is taken after the events, so it can
   * neither miss them nor count them twice.
   */
  _unreadFetchGen: number;
  _unreadFetchActive: boolean;
  _unreadFetchRaced: boolean;
  _unreadRefetches: number;
  /** Called by fetchChannels around its request; returns the generation to hand back. */
  beginUnreadFetch: () => number;
  applyServerUnread: (counts: Record<string, number> | null, gen: number) => void;
  /** Any local change to unread while a snapshot is in flight invalidates that snapshot. */
  noteUnreadRaced: () => void;

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
  /**
   * "I have seen everything on screen up to here." The watermark is a real message we hold and
   * could render — never an assumption. With nothing readable held there is nothing to claim,
   * so this does nothing at all. That is the point: it is what stops a client that decrypted
   * nothing from telling the server it read the conversation.
   */
  markDMReadUpTo: (channelId: string) => void;
  /** The user explicitly chose "Mark as read". Their claim, deliberately made — honour it. */
  markDMReadAll: (channelId: string) => void;
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
  _unreadFetchGen: 0,
  _unreadFetchActive: false,
  _unreadFetchRaced: false,
  _unreadRefetches: 0,

  beginUnreadFetch: () => {
    const gen = get()._unreadFetchGen + 1;
    set({ _unreadFetchGen: gen, _unreadFetchActive: true, _unreadFetchRaced: false });
    return gen;
  },

  noteUnreadRaced: () => {
    if (get()._unreadFetchActive) set({ _unreadFetchRaced: true });
  },

  applyServerUnread: (counts, gen) => {
    // A newer fetch has already superseded this one; its answer is the fresher truth.
    if (gen !== get()._unreadFetchGen) return;

    // The server did not tell us (old build, or the request failed). "It did not say" is not
    // "everything is read" — keep what we have rather than wiping every badge and, worse,
    // purging the notification tray on the way out.
    if (!counts) {
      set({ _unreadFetchActive: false, _unreadFetchRaced: false, _unreadRefetches: 0 });
      return;
    }

    // Events raced this snapshot, and a bare count cannot say whether it includes them.
    // Rather than guess (guessing high double-counts; guessing low drops the badge), throw the
    // snapshot away and take a fresh one from after the events.
    if (get()._unreadFetchRaced && get()._unreadRefetches < MAX_UNREAD_REFETCHES) {
      set((s) => ({ _unreadFetchActive: false, _unreadRefetches: s._unreadRefetches + 1 }));
      void get().fetchChannels();
      return;
    }

    // A device that was asleep or killed missed both the dm_read event and its retraction
    // push, so it can come back still showing notifications for conversations read long ago.
    void dismissReadNotifications(new Set(Object.keys(counts)));
    set({
      dmUnreadCounts: counts,
      _unreadFetchActive: false,
      _unreadFetchRaced: false,
      _unreadRefetches: 0,
    });
  },

  handleDMRead: ({ dm_channel_id, unread_count }) => {
    if (unread_count === 0) void dismissNotificationsFor(dm_channel_id);
    get().noteUnreadRaced();

    set((state) => {
      const next = { ...state.dmUnreadCounts };
      if (unread_count > 0) next[dm_channel_id] = unread_count;
      else delete next[dm_channel_id];
      return { dmUnreadCounts: next };
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
    get().noteUnreadRaced();
    set((state) => ({
      dmUnreadCounts: {
        ...state.dmUnreadCounts,
        [channelId]: (state.dmUnreadCounts[channelId] ?? 0) + 1,
      },
    }));
  },

  decrementDMUnread: (channelId) => {
    get().noteUnreadRaced();
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

  markDMReadUpTo: (channelId) => {
    // A client that decrypted nothing has read nothing. Saying otherwise here clears the badge
    // on every device and retracts the push from the phone that could still have shown it.
    if (useE2EEStore.getState().initStatus !== "ready") return;

    const watermark = readableWatermark(get().messagesByChannel[channelId]);
    if (!watermark) return;

    // Nothing new since the last time we said this.
    if (markReadAsked[channelId] === watermark.id) return;
    markReadAsked[channelId] = watermark.id;
    clearLocalUnread(set, get, channelId);

    // A window is already open; its trailing edge will carry this newer watermark.
    if (markReadTimers[channelId]) return;

    // Leading edge fires now — the user is in front of it and the server's push delay is already
    // counting down. The window then coalesces the burst that follows into a single POST.
    sendMarkRead(channelId, watermark.id);
    markReadTimers[channelId] = setTimeout(() => {
      delete markReadTimers[channelId];
      const latest = markReadAsked[channelId];
      if (latest && latest !== markReadSent[channelId]) sendMarkRead(channelId, latest);
    }, MARK_READ_COALESCE_MS);
  },

  markDMReadAll: (channelId) => {
    clearLocalUnread(set, get, channelId);
    // No message id: the server marks the conversation read to its newest message. Only ever
    // reached from the explicit "Mark as read" menu item — never inferred.
    sendMarkRead(channelId, undefined);
  },

  getTotalDMUnread: () => {
    const counts = get().dmUnreadCounts;
    return Object.values(counts).reduce((sum, c) => sum + c, 0);
  },
});
