/**
 * DM Store — Direct Messages state management.
 *
 * Stable empty refs (EMPTY_CHANNELS, EMPTY_MESSAGES) prevent infinite
 * re-renders in Zustand selectors.
 */

import { create } from "zustand";
import i18n from "../i18n";
import * as dmApi from "../api/dm";
import type { DMSearchResult } from "../api/dm";
import type { DMChannelWithUser, DMMessage, ReactionGroup } from "../types";
import { useToastStore } from "./toastStore";
import { useE2EEStore } from "./e2eeStore";
import { useAuthStore } from "./authStore";
import {
  encryptDMMessage,
  decryptDMMessages,
  pushSentPlaintext,
  discardLastSentPlaintext,
  persistSentPlaintext,
  cacheEditPlaintext,
} from "../crypto/dmEncryption";
import { encodePayload } from "../crypto/e2eePayload";
import {
  encryptFilesForE2EE,
  handleRateLimitError,
  createTypingHandler,
  updateMessageInRecord,
  deleteMessageFromRecord,
  updateReactionInRecord,
  updateAuthorInRecord,
} from "./shared/messageUtils";

const EMPTY_CHANNELS: DMChannelWithUser[] = [];
const EMPTY_MESSAGES: DMMessage[] = [];
const EMPTY_STRINGS: string[] = [];

/** Sorts DM channels: pinned first (by activity), then unpinned (by activity). */
function sortChannelsByActivity(channels: DMChannelWithUser[]): DMChannelWithUser[] {
  return [...channels].sort((a, b) => {
    if (a.is_pinned && !b.is_pinned) return -1;
    if (!a.is_pinned && b.is_pinned) return 1;
    const aTime = a.last_message_at ?? a.created_at;
    const bTime = b.last_message_at ?? b.created_at;
    return bTime.localeCompare(aTime);
  });
}

type DMState = {
  channels: DMChannelWithUser[];
  selectedDMId: string | null;
  /** Message cache: channelId -> DMMessage[] */
  messagesByChannel: Record<string, DMMessage[]>;
  /** Per-channel "has older messages?" flag */
  hasMoreByChannel: Record<string, boolean>;
  /** DM unread counts: channelId -> count */
  dmUnreadCounts: Record<string, number>;
  isLoading: boolean;
  isLoadingMessages: boolean;

  // ─── Reply State ───
  replyingTo: DMMessage | null;
  /** One-shot scroll target: scroll to this message ID and highlight */
  scrollToMessageId: string | null;

  // ─── Typing State ───
  /** Per-channel typing users: channelId -> username[] */
  typingUsers: Record<string, string[]>;

  // ─── DM Settings State ───
  /** Context menu "Search Messages" -> open DM + activate search panel */
  pendingSearchChannelId: string | null;

  // ─── Actions ───
  fetchChannels: () => Promise<void>;
  selectDM: (channelId: string | null) => void;
  createOrGetChannel: (userId: string) => Promise<string | null>;
  fetchMessages: (channelId: string) => Promise<void>;
  fetchOlderMessages: (channelId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string) => Promise<boolean>;
  editMessage: (messageId: string, content: string) => Promise<boolean>;
  deleteMessage: (messageId: string) => Promise<boolean>;

  // ─── Reply Actions ───
  setReplyingTo: (message: DMMessage | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  // ─── Reactions ───
  toggleReaction: (messageId: string, channelId: string, emoji: string) => Promise<void>;

  // ─── Pin ───
  pinMessage: (channelId: string, messageId: string) => Promise<void>;
  unpinMessage: (channelId: string, messageId: string) => Promise<void>;
  getPinnedMessages: (channelId: string) => Promise<DMMessage[]>;

  // ─── Search ───
  searchMessages: (channelId: string, query: string, limit?: number, offset?: number) => Promise<DMSearchResult>;

  // ─── Unread ───
  incrementDMUnread: (channelId: string) => void;
  decrementDMUnread: (channelId: string) => void;
  clearDMUnread: (channelId: string) => void;
  getTotalDMUnread: () => number;

  // ─── DM Settings Actions ───
  hideDM: (channelId: string) => Promise<void>;
  pinDM: (channelId: string) => Promise<void>;
  unpinDM: (channelId: string) => Promise<void>;
  /** Duration: "1h" / "8h" / "7d" / "forever" */
  muteDM: (channelId: string, duration: string) => Promise<void>;
  unmuteDM: (channelId: string) => Promise<void>;
  /** Fetch pinned + muted IDs and merge into channels */
  fetchDMSettings: () => Promise<void>;
  setPendingSearchChannelId: (id: string | null) => void;

  // ─── WS Event Handlers ───
  handleDMChannelCreate: (channel: DMChannelWithUser) => void;
  handleDMMessageCreate: (message: DMMessage) => void;
  handleDMMessageUpdate: (message: DMMessage) => void;
  handleDMMessageDelete: (data: { id: string; dm_channel_id: string }) => void;
  handleDMReactionUpdate: (data: { dm_message_id: string; dm_channel_id: string; reactions: ReactionGroup[] }) => void;
  handleDMTypingStart: (channelId: string, username: string) => void;
  handleDMMessagePin: (data: { dm_channel_id: string; message: DMMessage }) => void;
  handleDMMessageUnpin: (data: { dm_channel_id: string; message_id: string }) => void;
  handleDMSettingsUpdate: (data: { dm_channel_id: string; action: string }) => void;
  handleDMChannelUpdate: (channel: DMChannelWithUser) => void;
  /** Update author info across all cached DM messages. */
  handleDMAuthorUpdate: (userId: string, patch: { display_name?: string | null; avatar_url?: string | null }) => void;

  // ─── E2EE Toggle ───
  toggleE2EE: (channelId: string, enabled: boolean) => Promise<boolean>;

  // ─── Helpers ───
  getMessagesForChannel: (channelId: string) => DMMessage[];
  getTypingUsers: (channelId: string) => string[];
  /** Clear message cache for a channel — forces re-fetch after E2EE init */
  invalidateMessages: (channelId: string) => void;
  /** Clear all DM message caches — used after E2EE key restore */
  invalidateFetchCache: () => void;
};

export const useDMStore = create<DMState>((set, get) => ({
  channels: EMPTY_CHANNELS,
  selectedDMId: null,
  messagesByChannel: {},
  hasMoreByChannel: {},
  dmUnreadCounts: {},
  isLoading: false,
  isLoadingMessages: false,
  replyingTo: null,
  scrollToMessageId: null,
  typingUsers: {},
  pendingSearchChannelId: null,

  fetchChannels: async () => {
    set({ isLoading: true });
    const res = await dmApi.listDMChannels();
    if (res.success && res.data) {
      set({ channels: res.data, isLoading: false });
    } else {
      set({ isLoading: false });
    }
  },

  selectDM: (channelId) => {
    set({ selectedDMId: channelId });
  },

  createOrGetChannel: async (userId) => {
    const res = await dmApi.createDMChannel(userId);
    if (res.success && res.data) {
      set((state) => {
        const exists = state.channels.some((ch) => ch.id === res.data!.id);
        if (exists) return state;
        return { channels: [res.data!, ...state.channels] };
      });
      return res.data.id;
    }
    return null;
  },

  fetchMessages: async (channelId) => {
    if (get().messagesByChannel[channelId]) return;

    // Don't fetch if E2EE isn't ready — messages would be cached with null content
    // and can never be decrypted. DMChatContent will retry when initStatus becomes "ready".
    const e2eeStatus = useE2EEStore.getState().initStatus;
    if (e2eeStatus !== "ready") return;

    set({ isLoadingMessages: true });

    const res = await dmApi.getDMMessages(channelId, undefined, 50);
    if (res.success && res.data) {
      const messages = await decryptDMMessages(res.data!.messages ?? []);

      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: messages,
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: res.data!.has_more,
        },
        isLoadingMessages: false,
      }));
    } else {
      set({ isLoadingMessages: false });
    }
  },

  fetchOlderMessages: async (channelId) => {
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreByChannel[channelId]) return;

    const beforeId = messages[0].id;
    const res = await dmApi.getDMMessages(channelId, beforeId, 50);
    if (res.success && res.data) {
      const decrypted = await decryptDMMessages(res.data!.messages);

      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: [...decrypted, ...state.messagesByChannel[channelId]],
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: res.data!.has_more,
        },
      }));
    }
  },

  /**
   * Sends a DM message with E2EE if the channel has it enabled.
   *
   * E2EE flow: fetch recipient prekey bundles -> encrypt per-device (Signal Protocol)
   * -> encrypt for own other devices (self-fanout) -> send via encrypted endpoint.
   *
   * Falls back to plaintext if E2EE is disabled or recipient has no keys.
   */
  sendMessage: async (channelId, content, files, replyToId) => {
    const e2eeState = useE2EEStore.getState();

    const dmChannel = get().channels.find((ch) => ch.id === channelId);
    if (dmChannel?.e2ee_enabled && e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const channel = dmChannel;
      const currentUserId = useAuthStore.getState().user?.id;

      if (channel && currentUserId) {
        try {
          let encryptedFiles: File[] | undefined;
          let fileMetas: import("../crypto/fileEncryption").EncryptedFileMeta[] | undefined;

          if (files && files.length > 0) {
            const result = await encryptFilesForE2EE(files);
            encryptedFiles = result.files;
            fileMetas = result.metas;
          }

          const plaintext = encodePayload(content, fileMetas);

          const envelopes = await encryptDMMessage(
            currentUserId,
            channel.other_user.id,
            e2eeState.localDeviceId,
            plaintext
          );

          const ciphertext = JSON.stringify(envelopes);
          const metadata = JSON.stringify({});

          // Push plaintext to in-memory FIFO cache before API call.
          // WS echo only arrives after server processes it, so cache is always ready.
          pushSentPlaintext(channelId, { content, file_keys: fileMetas });

          const res = await dmApi.sendEncryptedDMMessage(
            channelId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata,
            encryptedFiles,
            replyToId
          );

          if (res.success && res.data) {
            // Persist to IndexedDB for historical fetch access.
            // Await to ensure it's written before WS echo arrives
            // (fallback for HMR clearing in-memory cache).
            try {
              await persistSentPlaintext(res.data.id, channelId, content);
            } catch {
              // IndexedDB error — message was still sent, cache is optional
            }
          }

          if (!res.success) {
            discardLastSentPlaintext(channelId);
            handleRateLimitError(res);
          }

          return res.success;
        } catch (err) {
          discardLastSentPlaintext(channelId);
          console.error("[dmStore] E2EE encrypt failed:", err);

          // Fallback to plaintext if recipient has no E2EE keys
          const errMsg = err instanceof Error ? err.message : "";
          if (errMsg === "RECIPIENT_NO_KEYS") {
            const fallbackRes = await dmApi.sendDMMessage(channelId, content, files, replyToId);
            handleRateLimitError(fallbackRes);
            return fallbackRes.success;
          }
          useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
          return false;
        }
      }
    }

    // No E2EE — send plaintext (legacy)
    const res = await dmApi.sendDMMessage(channelId, content, files, replyToId);
    handleRateLimitError(res);
    return res.success;
  },

  editMessage: async (messageId, content) => {
    const e2eeState = useE2EEStore.getState();

    // Find the message's channel and recipient for E2EE
    const editState = get();
    let recipientUserId: string | null = null;
    let editChannelE2EE = false;
    for (const [chId, msgs] of Object.entries(editState.messagesByChannel)) {
      if (msgs.some((m) => m.id === messageId)) {
        const ch = editState.channels.find((c) => c.id === chId);
        if (ch) {
          recipientUserId = ch.other_user.id;
          editChannelE2EE = ch.e2ee_enabled;
        }
        break;
      }
    }

    if (editChannelE2EE && e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {

      const currentUserId = useAuthStore.getState().user?.id;

      if (recipientUserId && currentUserId) {
        try {
          const envelopes = await encryptDMMessage(
            currentUserId,
            recipientUserId,
            e2eeState.localDeviceId,
            content
          );

          const ciphertext = JSON.stringify(envelopes);
          const metadata = JSON.stringify({});

          // Cache edit plaintext for WS echo decryption
          cacheEditPlaintext(messageId, { content });

          const res = await dmApi.editEncryptedDMMessage(
            messageId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata
          );

          if (res.success) {
            // Update IndexedDB cache for search + fetch
            persistSentPlaintext(messageId, "", content).catch(() => {});
          }

          return res.success;
        } catch (err) {
          console.error("[dmStore] E2EE edit encrypt failed:", err);
          const editErrMsg = err instanceof Error ? err.message : "";
          if (editErrMsg === "RECIPIENT_NO_KEYS") {
            const fallbackRes = await dmApi.editDMMessage(messageId, content);
            return fallbackRes.success;
          }
          useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
          return false;
        }
      }
    }

    // Plaintext edit
    const res = await dmApi.editDMMessage(messageId, content);
    return res.success;
  },

  deleteMessage: async (messageId) => {
    const res = await dmApi.deleteDMMessage(messageId);
    return res.success;
  },

  // ─── Reply Actions ───

  setReplyingTo: (message) => set({ replyingTo: message }),

  /** Set once, UI scrolls + highlights, then resets to null. */
  setScrollToMessageId: (id) => set({ scrollToMessageId: id }),

  // ─── Reactions ───

  /** No optimistic update — WS event (handleDMReactionUpdate) updates state. */
  toggleReaction: async (messageId, _channelId, emoji) => {
    await dmApi.toggleDMReaction(messageId, emoji);
  },

  // ─── Pin ───

  pinMessage: async (_channelId, messageId) => {
    await dmApi.pinDMMessage(messageId);
  },

  unpinMessage: async (_channelId, messageId) => {
    await dmApi.unpinDMMessage(messageId);
  },

  getPinnedMessages: async (channelId) => {
    const res = await dmApi.getDMPinnedMessages(channelId);
    if (res.success && res.data) {
      return res.data;
    }
    return [];
  },

  // ─── Search ───

  searchMessages: async (channelId, query, limit = 25, offset = 0) => {
    const res = await dmApi.searchDMMessages(channelId, query, limit, offset);
    if (res.success && res.data) {
      return res.data;
    }
    return { messages: [], total_count: 0 };
  },

  // ─── DM Settings Actions ───

  /**
   * Hides DM from sidebar. Backend auto-unhides on new message (arrives via WS).
   */
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

  /** Fetches pinned + muted DM IDs and syncs with local channel state. */
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

  // ─── Unread ───

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

  // ─── WS Event Handlers ───

  handleDMChannelCreate: (channel) => {
    set((state) => {
      if (state.channels.some((ch) => ch.id === channel.id)) return state;
      return { channels: [channel, ...state.channels] };
    });
  },

  handleDMMessageCreate: (message) => {
    set((state) => {
      // Update channel ordering even if message cache isn't loaded
      const updatedChannels = state.channels.map((ch) =>
        ch.id === message.dm_channel_id
          ? { ...ch, last_message_at: message.created_at }
          : ch
      );
      const sortedChannels = sortChannelsByActivity(updatedChannels);

      // Clear typing indicator (message arrived = done typing)
      const typingUsers = { ...state.typingUsers };
      if (typingUsers[message.dm_channel_id]) {
        typingUsers[message.dm_channel_id] = typingUsers[message.dm_channel_id].filter(
          (u) => u !== message.author?.username
        );
      }

      const channelMessages = state.messagesByChannel[message.dm_channel_id];
      if (!channelMessages) {
        return { channels: sortedChannels, typingUsers };
      }

      if (channelMessages.some((m) => m.id === message.id)) {
        return { channels: sortedChannels, typingUsers };
      }

      return {
        channels: sortedChannels,
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.dm_channel_id]: [...channelMessages, message],
        },
        typingUsers,
      };
    });
  },

  handleDMMessageUpdate: (message) => {
    set((state) => ({
      messagesByChannel: updateMessageInRecord(
        state.messagesByChannel, message.dm_channel_id, message
      ),
    }));
  },

  handleDMMessageDelete: (data) => {
    set((state) => ({
      messagesByChannel: deleteMessageFromRecord(
        state.messagesByChannel, data.dm_channel_id, data.id
      ),
    }));
  },

  /** Backend sends full reaction list after each toggle — direct replace. */
  handleDMReactionUpdate: (data) => {
    set((state) => ({
      messagesByChannel: updateReactionInRecord(
        state.messagesByChannel, data.dm_channel_id, data.dm_message_id, data.reactions
      ),
    }));
  },

  /** Adds user to typing list with 5s auto-cleanup timer. */
  handleDMTypingStart: createTypingHandler(set),

  handleDMMessagePin: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.dm_channel_id]: channelMessages.map((m) =>
            m.id === data.message.id ? { ...m, is_pinned: true } : m
          ),
        },
      };
    });
  },

  handleDMMessageUnpin: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.dm_channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.dm_channel_id]: channelMessages.map((m) =>
            m.id === data.message_id ? { ...m, is_pinned: false } : m
          ),
        },
      };
    });
  },

  /** Handles hide/unhide/pin/unpin/mute/unmute actions from WS broadcast. */
  handleDMSettingsUpdate: (data) => {
    const { dm_channel_id, action } = data;

    switch (action) {
      case "hidden":
        set((state) => ({
          channels: state.channels.filter((ch) => ch.id !== dm_channel_id),
          selectedDMId: state.selectedDMId === dm_channel_id ? null : state.selectedDMId,
        }));
        break;

      case "unhidden":
        // Re-fetch channels (new message may have triggered unhide)
        get().fetchChannels();
        break;

      case "pinned":
        set((state) => ({
          channels: sortChannelsByActivity(
            state.channels.map((ch) =>
              ch.id === dm_channel_id ? { ...ch, is_pinned: true } : ch
            )
          ),
        }));
        break;

      case "unpinned":
        set((state) => ({
          channels: sortChannelsByActivity(
            state.channels.map((ch) =>
              ch.id === dm_channel_id ? { ...ch, is_pinned: false } : ch
            )
          ),
        }));
        break;

      case "muted":
        set((state) => ({
          channels: state.channels.map((ch) =>
            ch.id === dm_channel_id ? { ...ch, is_muted: true } : ch
          ),
        }));
        break;

      case "unmuted":
        set((state) => ({
          channels: state.channels.map((ch) =>
            ch.id === dm_channel_id ? { ...ch, is_muted: false } : ch
          ),
        }));
        break;
    }
  },

  handleDMChannelUpdate: (channel) => {
    set((state) => ({
      channels: state.channels.map((ch) =>
        ch.id === channel.id ? { ...ch, ...channel } : ch
      ),
    }));
  },

  handleDMAuthorUpdate: (userId, patch) => {
    set((state) => {
      const { updated, changed: messagesChanged } = updateAuthorInRecord(
        state.messagesByChannel, userId, patch
      );

      // Also update other_user in DM channel list
      let channelsChanged = false;
      const updatedChannels = state.channels.map((ch) => {
        if (ch.other_user?.id !== userId) return ch;
        channelsChanged = true;
        return { ...ch, other_user: { ...ch.other_user, ...patch } };
      });

      return (messagesChanged || channelsChanged)
        ? { messagesByChannel: updated, channels: updatedChannels }
        : state;
    });
  },

  toggleE2EE: async (channelId, enabled) => {
    const res = await dmApi.toggleDME2EE(channelId, enabled);
    if (res.success && res.data) {
      set((state) => ({
        channels: state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, e2ee_enabled: enabled } : ch
        ),
      }));
    }
    return res.success;
  },

  // ─── Helpers ───

  getMessagesForChannel: (channelId) => {
    return get().messagesByChannel[channelId] ?? EMPTY_MESSAGES;
  },

  getTypingUsers: (channelId) => {
    return get().typingUsers[channelId] ?? EMPTY_STRINGS;
  },

  invalidateMessages: (channelId) => {
    set((state) => {
      const { [channelId]: _, ...rest } = state.messagesByChannel;
      const { [channelId]: __, ...restMore } = state.hasMoreByChannel;
      return { messagesByChannel: rest, hasMoreByChannel: restMore };
    });
  },

  invalidateFetchCache: () => {
    set({ messagesByChannel: {}, hasMoreByChannel: {} });
  },
}));
