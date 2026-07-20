/**
 * Message Store — Channel message state management.
 */

import { create } from "zustand";
import i18n from "../i18n";
import * as messageApi from "../api/messages";
import * as reactionApi from "../api/reactions";
import type { UploadOptions } from "../api/client";
import { createThumbnail } from "../utils/imageEncoding";
import { useServerStore, selectServerE2EE } from "./serverStore";
import { useE2EEStore } from "./e2eeStore";
import { useAuthStore } from "./authStore";
import { useReadStateStore } from "./readStateStore";
import { useToastStore } from "./toastStore";
import { encryptChannelMessage, decryptChannelMessages } from "../crypto/channelEncryption";
import { encodePayload } from "../crypto/e2eePayload";
import type { Message, ReactionGroup } from "../types";
import { DEFAULT_MESSAGE_LIMIT } from "../utils/constants";
import { mergeLatestPage } from "../utils/messageSync";
import {
  encryptFilesForE2EE,
  handleSendError,
  createTypingHandler,
  updateMessageInRecord,
  deleteMessageFromRecord,
  updateReactionInRecord,
  updateAuthorInRecord,
} from "./shared/messageUtils";

type MessageState = {
  /** channelId -> Message[] */
  messagesByChannel: Record<string, Message[]>;
  hasMoreByChannel: Record<string, boolean>;
  isLoading: boolean;
  isLoadingMore: boolean;
  /** channelId -> username[] */
  typingUsers: Record<string, string[]>;

  // ─── Reply State ───
  replyingTo: Message | null;
  scrollToMessageId: string | null;

  // ─── Actions ───
  fetchMessages: (channelId: string, serverId?: string) => Promise<void>;
  fetchOlderMessages: (channelId: string, serverId?: string) => Promise<void>;
  /** Re-fetch the newest page and fold it in — recovers messages a dead socket never delivered */
  resyncChannel: (channelId: string, serverId?: string) => Promise<void>;
  /** Clear fetch cache — forces re-fetch + re-decrypt (E2EE restore) */
  invalidateFetchCache: () => void;
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string, serverId?: string, upload?: UploadOptions) => Promise<boolean>;
  editMessage: (messageId: string, content: string, serverId?: string) => Promise<boolean>;
  deleteMessage: (messageId: string, serverId?: string) => Promise<boolean>;

  // ─── Reply Actions ───
  setReplyingTo: (message: Message | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  // ─── Reactions ───
  toggleReaction: (messageId: string, channelId: string, emoji: string, serverId?: string) => Promise<void>;

  // ─── WS Event Handlers ───
  handleMessageCreate: (message: Message) => void;
  handleMessageUpdate: (message: Message) => void;
  handleMessageDelete: (data: { id: string; channel_id: string }) => void;
  handleTypingStart: (channelId: string, username: string) => void;
  handleReactionUpdate: (data: { message_id: string; channel_id: string; reactions: ReactionGroup[] }) => void;
  /** Update author info across all cached messages (display_name, avatar change). */
  handleAuthorUpdate: (userId: string, patch: { display_name?: string | null; avatar_url?: string | null }) => void;
};

/**
 * Tracks channels that have been fetched from API (not just WS-buffered).
 * Separate from messagesByChannel because WS messages can buffer before fetch completes.
 */
const fetchedChannels = new Set<string>();

export const useMessageStore = create<MessageState>((set, get) => ({
  messagesByChannel: {},
  hasMoreByChannel: {},
  isLoading: false,
  isLoadingMore: false,
  typingUsers: {},
  replyingTo: null,
  scrollToMessageId: null,

  invalidateFetchCache: () => {
    fetchedChannels.clear();
    set({ messagesByChannel: {}, hasMoreByChannel: {} });
  },

  resyncChannel: async (channelId, explicitServerId?) => {
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return;

    const res = await messageApi.getMessages(serverId, channelId, undefined, DEFAULT_MESSAGE_LIMIT);
    if (!res.success || !res.data) return;
    const data = res.data;

    // Decrypting before the keys are loaded yields null content, and the normal init path
    // doesn't invalidate the cache — so leave the fetch cache alone and let the mount-time
    // fetch cover it once E2EE is up.
    const raw = data.messages ?? [];
    if (
      useE2EEStore.getState().initStatus !== "ready" &&
      raw.some((m) => m.encryption_version === 1)
    ) {
      return;
    }

    const page = await decryptChannelMessages(raw);
    fetchedChannels.add(channelId);

    set((state) => {
      const held = state.messagesByChannel[channelId] ?? [];
      const { messages, replaced } = mergeLatestPage(held, page);
      return {
        messagesByChannel: { ...state.messagesByChannel, [channelId]: messages },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: replaced ? data.has_more : (state.hasMoreByChannel[channelId] ?? data.has_more),
        },
      };
    });

    const merged = get().messagesByChannel[channelId];
    if (merged && merged.length > 0) {
      useReadStateStore.getState().markAsRead(channelId, merged[merged.length - 1].id);
    }
  },

  fetchMessages: async (channelId, explicitServerId?) => {
    if (fetchedChannels.has(channelId)) return;

    set({ isLoading: true });

    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) { set({ isLoading: false }); return; }

    const res = await messageApi.getMessages(serverId, channelId, undefined, DEFAULT_MESSAGE_LIMIT);
    if (res.success && res.data) {
      fetchedChannels.add(channelId);

      // Go nil slice -> JSON null; fallback to empty array
      const apiMessages = await decryptChannelMessages(res.data.messages ?? []);

      set((state) => {
        // Merge WS-buffered messages that arrived during fetch
        const buffered = state.messagesByChannel[channelId] ?? [];
        const apiIds = new Set(apiMessages.map((m) => m.id));
        const newFromWS = buffered.filter((m) => !apiIds.has(m.id));

        return {
          messagesByChannel: {
            ...state.messagesByChannel,
            [channelId]: [...apiMessages, ...newFromWS],
          },
          hasMoreByChannel: {
            ...state.hasMoreByChannel,
            [channelId]: res.data!.has_more,
          },
          isLoading: false,
        };
      });

      // Auto-mark-read after messages load
      const allMessages = get().messagesByChannel[channelId];
      if (allMessages && allMessages.length > 0) {
        const lastMsg = allMessages[allMessages.length - 1];
        useReadStateStore.getState().markAsRead(channelId, lastMsg.id);
      }
    } else {
      set({ isLoading: false });
    }
  },

  fetchOlderMessages: async (channelId, explicitServerId?) => {
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreByChannel[channelId]) return;

    set({ isLoadingMore: true });

    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) { set({ isLoadingMore: false }); return; }

    const beforeId = messages[0].id;
    const res = await messageApi.getMessages(serverId, channelId, beforeId, DEFAULT_MESSAGE_LIMIT);

    if (res.success && res.data) {
      const decrypted = await decryptChannelMessages(res.data.messages ?? []);

      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: [...decrypted, ...state.messagesByChannel[channelId]],
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: res.data!.has_more,
        },
        isLoadingMore: false,
      }));
    } else {
      set({ isLoadingMore: false });
    }
  },

  sendMessage: async (channelId, content, files, replyToId, explicitServerId?, upload?) => {
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return false;

    // E2EE: encrypt with Sender Key.
    // Read the flag for the server this message is actually going to. Reading `activeServer` sent
    // a plaintext message to an E2EE server (or the reverse) whenever a tab held a channel of a
    // non-active server — explicitServerId exists precisely because that happens.
    const e2eeState = useE2EEStore.getState();
    const targetServerE2EE = selectServerE2EE(serverId)(useServerStore.getState());
    if (targetServerE2EE && e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const currentUserId = useAuthStore.getState().user?.id;
      if (currentUserId) {
        try {
          let encryptedFiles: File[] | undefined;
          let thumbs: (import("../utils/imageEncoding").GeneratedThumbnail | null)[] | undefined;
          let fileMetas: import("../crypto/fileEncryption").EncryptedFileMeta[] | undefined;

          if (files && files.length > 0) {
            const result = await encryptFilesForE2EE(files);
            encryptedFiles = result.files;
            thumbs = result.thumbs;
            fileMetas = result.metas;
          }

          const plaintext = encodePayload(content, fileMetas);

          const senderKeyMsg = await encryptChannelMessage(
            channelId,
            currentUserId,
            e2eeState.localDeviceId,
            plaintext
          );
          const ciphertext = JSON.stringify(senderKeyMsg);
          const metadata = JSON.stringify({
            distribution_id: senderKeyMsg.distributionId,
          });

          const res = await messageApi.sendEncryptedMessage(
            serverId,
            channelId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata,
            encryptedFiles,
            replyToId,
            upload,
            thumbs
          );

          handleSendError(res);
          return res.success;
        } catch (err) {
          console.error("[messageStore] E2EE encryption failed:", err);
          useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
          return false;
        }
      }
    }

    // Plaintext fallback
    // Previews are generated here, not in the api layer, so the encrypted and plaintext paths
    // produce them the same way. Non-images and already-small files come back null.
    const plainThumbs = files ? await Promise.all(files.map(createThumbnail)) : undefined;
    const res = await messageApi.sendMessage(serverId, channelId, content, files, replyToId, upload, plainThumbs);
    handleSendError(res);
    return res.success;
  },

  editMessage: async (messageId, content, explicitServerId?) => {
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return false;

    // E2EE encrypted edit
    const e2eeState = useE2EEStore.getState();
    // Same rule as sendMessage: the flag must come from the server being edited in, not the active one.
    const editServerE2EE = selectServerE2EE(serverId)(useServerStore.getState());
    if (editServerE2EE && e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const currentUserId = useAuthStore.getState().user?.id;
      // Find which channel this message belongs to
      const allChannels = get().messagesByChannel;
      let channelId: string | null = null;
      for (const [chId, msgs] of Object.entries(allChannels)) {
        if (msgs.some((m) => m.id === messageId)) {
          channelId = chId;
          break;
        }
      }

      if (currentUserId && channelId) {
        try {
          const senderKeyMsg = await encryptChannelMessage(
            channelId,
            currentUserId,
            e2eeState.localDeviceId,
            content
          );
          const ciphertext = JSON.stringify(senderKeyMsg);
          const metadata = JSON.stringify({
            distribution_id: senderKeyMsg.distributionId,
          });

          const res = await messageApi.editEncryptedMessage(
            serverId,
            messageId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata
          );
          return res.success;
        } catch (err) {
          console.error("[messageStore] E2EE edit encryption failed:", err);
          useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
          return false;
        }
      }
    }

    // Plaintext fallback
    const res = await messageApi.editMessage(serverId, messageId, content);
    return res.success;
  },

  deleteMessage: async (messageId, explicitServerId?) => {
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return false;
    const res = await messageApi.deleteMessage(serverId, messageId);
    return res.success;
  },

  // ─── Reply Actions ───

  setReplyingTo: (message) => set({ replyingTo: message }),

  /** One-shot: UI scrolls to message and highlights, then resets to null. */
  setScrollToMessageId: (id) => set({ scrollToMessageId: id }),

  // ─── Reactions ───

  /** No optimistic update — WS event will update via handleReactionUpdate. */
  toggleReaction: async (messageId, _channelId, emoji, explicitServerId?) => {
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return;
    await reactionApi.toggleReaction(serverId, messageId, emoji);
  },

  // ─── WebSocket Event Handlers ───

  handleMessageCreate: (message) => {
    set((state) => {
      // Buffer messages even if channel isn't fetched yet.
      // fetchMessages will merge buffered messages when it completes.
      const channelMessages = state.messagesByChannel[message.channel_id] ?? [];

      // Duplicate guard
      if (channelMessages.some((m) => m.id === message.id)) return state;

      // Clear typing indicator
      const typingUsers = { ...state.typingUsers };
      if (typingUsers[message.channel_id]) {
        typingUsers[message.channel_id] = typingUsers[message.channel_id].filter(
          (u) => u !== message.author?.username
        );
      }

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.channel_id]: [...channelMessages, message],
        },
        typingUsers,
      };
    });
  },

  handleMessageUpdate: (message) => {
    set((state) => ({
      messagesByChannel: updateMessageInRecord(
        state.messagesByChannel, message.channel_id, message
      ),
    }));
  },

  handleMessageDelete: (data) => {
    set((state) => ({
      messagesByChannel: deleteMessageFromRecord(
        state.messagesByChannel, data.channel_id, data.id
      ),
    }));
  },

  /** Auto-cleared after 5s if no new typing event arrives. */
  handleTypingStart: createTypingHandler(set),

  /** Backend sends full reaction list after each toggle — direct replace, no client merge. */
  handleReactionUpdate: (data) => {
    set((state) => ({
      messagesByChannel: updateReactionInRecord(
        state.messagesByChannel, data.channel_id, data.message_id, data.reactions
      ),
    }));
  },

  handleAuthorUpdate: (userId, patch) => {
    set((state) => {
      const { updated, changed } = updateAuthorInRecord(
        state.messagesByChannel, userId, patch
      );
      return changed ? { messagesByChannel: updated } : state;
    });
  },
}));
