/**
 * Message Store — Channel message state management.
 */

import { create } from "zustand";
import i18n from "../i18n";
import * as messageApi from "../api/messages";
import * as reactionApi from "../api/reactions";
import { useServerStore } from "./serverStore";
import { useE2EEStore } from "./e2eeStore";
import { useAuthStore } from "./authStore";
import { useReadStateStore } from "./readStateStore";
import { useToastStore } from "./toastStore";
import { encryptChannelMessage, decryptChannelMessages } from "../crypto/channelEncryption";
import { encryptFile } from "../crypto/fileEncryption";
import { encodePayload } from "../crypto/e2eePayload";
import type { Message, ReactionGroup } from "../types";
import type { EncryptedFileMeta } from "../crypto/fileEncryption";
import { DEFAULT_MESSAGE_LIMIT } from "../utils/constants";

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
  fetchMessages: (channelId: string) => Promise<void>;
  fetchOlderMessages: (channelId: string) => Promise<void>;
  /** Clear fetch cache — forces re-fetch + re-decrypt (E2EE restore) */
  invalidateFetchCache: () => void;
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string) => Promise<boolean>;
  editMessage: (messageId: string, content: string) => Promise<boolean>;
  deleteMessage: (messageId: string) => Promise<boolean>;

  // ─── Reply Actions ───
  setReplyingTo: (message: Message | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  // ─── Reactions ───
  toggleReaction: (messageId: string, channelId: string, emoji: string) => Promise<void>;

  // ─── WS Event Handlers ───
  handleMessageCreate: (message: Message) => void;
  handleMessageUpdate: (message: Message) => void;
  handleMessageDelete: (data: { id: string; channel_id: string }) => void;
  handleTypingStart: (channelId: string, username: string) => void;
  handleReactionUpdate: (data: { message_id: string; channel_id: string; reactions: ReactionGroup[] }) => void;
  /** Update author info across all cached messages (display_name, avatar change). */
  handleAuthorUpdate: (userId: string, patch: { display_name?: string | null; avatar_url?: string | null }) => void;
};

const TYPING_TIMEOUT = 5_000;
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  fetchMessages: async (channelId) => {
    if (fetchedChannels.has(channelId)) return;

    set({ isLoading: true });

    const serverId = useServerStore.getState().activeServerId;
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

  fetchOlderMessages: async (channelId) => {
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreByChannel[channelId]) return;

    set({ isLoadingMore: true });

    const serverId = useServerStore.getState().activeServerId;
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

  sendMessage: async (channelId, content, files, replyToId) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    // E2EE: encrypt with Sender Key
    const e2eeState = useE2EEStore.getState();
    const activeServer = useServerStore.getState().activeServer;
    if (activeServer?.e2ee_enabled && e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const currentUserId = useAuthStore.getState().user?.id;
      if (currentUserId) {
        try {
          // Encrypt files with AES-256-GCM
          let encryptedFiles: File[] | undefined;
          let fileMetas: EncryptedFileMeta[] | undefined;

          if (files && files.length > 0) {
            encryptedFiles = [];
            fileMetas = [];

            for (let i = 0; i < files.length; i++) {
              const result = await encryptFile(files[i]);
              encryptedFiles.push(
                new File(
                  [result.encryptedBlob],
                  `encrypted_${i}.bin`,
                  { type: "application/octet-stream" }
                )
              );
              fileMetas.push(result.meta);
            }
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
            replyToId
          );

          if (!res.success && res.error?.includes("too many")) {
            useToastStore.getState().addToast("warning", i18n.t("chat:tooManyMessages"));
          }

          return res.success;
        } catch (err) {
          console.error("[messageStore] E2EE encryption failed:", err);
          useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
          return false;
        }
      }
    }

    // Plaintext fallback
    const res = await messageApi.sendMessage(serverId, channelId, content, files, replyToId);

    if (!res.success && res.error?.includes("too many")) {
      useToastStore.getState().addToast("warning", i18n.t("chat:tooManyMessages"));
    }

    return res.success;
  },

  editMessage: async (messageId, content) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return false;

    // E2EE encrypted edit
    const e2eeState = useE2EEStore.getState();
    const activeServerForEdit = useServerStore.getState().activeServer;
    if (activeServerForEdit?.e2ee_enabled && e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
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

  deleteMessage: async (messageId) => {
    const serverId = useServerStore.getState().activeServerId;
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
  toggleReaction: async (messageId, _channelId, emoji) => {
    const serverId = useServerStore.getState().activeServerId;
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
    set((state) => {
      const channelMessages = state.messagesByChannel[message.channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.channel_id]: channelMessages.map((m) =>
            m.id === message.id ? message : m
          ),
        },
      };
    });
  },

  handleMessageDelete: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.channel_id];
      if (!channelMessages) return state;

      // Remove deleted message + null out referenced_message for replies to it
      const updated = channelMessages
        .filter((m) => m.id !== data.id)
        .map((m) =>
          m.reply_to_id === data.id
            ? { ...m, referenced_message: { id: data.id, author: null, content: null } }
            : m
        );

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.channel_id]: updated,
        },
      };
    });
  },

  /** Auto-cleared after 5s if no new typing event arrives. */
  handleTypingStart: (channelId, username) => {
    set((state) => {
      const current = state.typingUsers[channelId] ?? [];
      if (current.includes(username)) return state;

      return {
        typingUsers: {
          ...state.typingUsers,
          [channelId]: [...current, username],
        },
      };
    });

    const key = `${channelId}:${username}`;
    const existingTimer = typingTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);

    typingTimers.set(
      key,
      setTimeout(() => {
        set((state) => ({
          typingUsers: {
            ...state.typingUsers,
            [channelId]: (state.typingUsers[channelId] ?? []).filter(
              (u) => u !== username
            ),
          },
        }));
        typingTimers.delete(key);
      }, TYPING_TIMEOUT)
    );
  },

  /** Backend sends full reaction list after each toggle — direct replace, no client merge. */
  handleReactionUpdate: (data) => {
    set((state) => {
      const channelMessages = state.messagesByChannel[data.channel_id];
      if (!channelMessages) return state;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [data.channel_id]: channelMessages.map((m) =>
            m.id === data.message_id
              ? { ...m, reactions: data.reactions }
              : m
          ),
        },
      };
    });
  },

  handleAuthorUpdate: (userId, patch) => {
    set((state) => {
      const updated: Record<string, Message[]> = {};
      let changed = false;

      for (const [chId, msgs] of Object.entries(state.messagesByChannel)) {
        const newMsgs = msgs.map((m) => {
          if (m.author?.id !== userId) return m;
          changed = true;
          return { ...m, author: { ...m.author, ...patch } };
        });
        updated[chId] = newMsgs;
      }

      return changed ? { messagesByChannel: updated } : state;
    });
  },
}));
