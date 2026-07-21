import { create } from "zustand";
import i18n from "../i18n";
import * as dmApi from "../api/dm";
import type { DMSearchResult } from "../api/dm";
import type { UploadOptions } from "../api/client";
import { buildAttachmentPreview } from "../utils/attachmentPreview";
import { mapWithConcurrency } from "../utils/concurrency";
import { PREVIEW_CONCURRENCY } from "../utils/constants";
import type { DMChannelWithUser, DMMessage } from "../types";
import { useUIStore } from "./uiStore";
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
import { mergeLatestPage } from "../utils/messageSync";
import {
  encryptFilesForE2EE,
  handleSendError,
} from "./shared/messageUtils";
import {
  createDMSettingsSlice,
  type DMSettingsSlice,
} from "./slices/dmSettingsSlice";
import {
  createDMWsSlice,
  type DMWsSlice,
} from "./slices/dmWsSlice";

const EMPTY_CHANNELS: DMChannelWithUser[] = [];
const EMPTY_MESSAGES: DMMessage[] = [];
const EMPTY_STRINGS: string[] = [];

type DMCoreState = {
  channels: DMChannelWithUser[];
  selectedDMId: string | null;
  messagesByChannel: Record<string, DMMessage[]>;
  hasMoreByChannel: Record<string, boolean>;
  isLoading: boolean;
  isLoadingMessages: boolean;

  replyingTo: DMMessage | null;
  scrollToMessageId: string | null;

  typingUsers: Record<string, string[]>;

  fetchChannels: () => Promise<void>;
  selectDM: (channelId: string | null) => void;
  createOrGetChannel: (userId: string) => Promise<string | null>;
  fetchMessages: (channelId: string) => Promise<void>;
  fetchOlderMessages: (channelId: string) => Promise<void>;
  /** Re-fetch the newest page and fold it in — recovers messages a dead socket never delivered */
  resyncChannel: (channelId: string) => Promise<void>;
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string, upload?: UploadOptions) => Promise<boolean>;
  editMessage: (messageId: string, content: string) => Promise<boolean>;
  deleteMessage: (messageId: string) => Promise<boolean>;

  setReplyingTo: (message: DMMessage | null) => void;
  setScrollToMessageId: (id: string | null) => void;

  toggleReaction: (messageId: string, channelId: string, emoji: string) => Promise<void>;

  pinMessage: (channelId: string, messageId: string) => Promise<void>;
  unpinMessage: (channelId: string, messageId: string) => Promise<void>;
  getPinnedMessages: (channelId: string) => Promise<DMMessage[]>;

  searchMessages: (channelId: string, query: string, limit?: number, offset?: number) => Promise<DMSearchResult>;

  acceptDMRequest: (channelId: string) => Promise<void>;
  declineDMRequest: (channelId: string) => Promise<void>;

  toggleE2EE: (channelId: string, enabled: boolean) => Promise<boolean>;

  getMessagesForChannel: (channelId: string) => DMMessage[];
  getTypingUsers: (channelId: string) => string[];
  invalidateMessages: (channelId: string) => void;
  invalidateFetchCache: () => void;
};

export type DMStore = DMCoreState & DMSettingsSlice & DMWsSlice;

export const useDMStore = create<DMStore>((set, get, store) => ({
  ...createDMSettingsSlice(set, get, store),
  ...createDMWsSlice(set, get, store),

  channels: EMPTY_CHANNELS,
  selectedDMId: null,
  messagesByChannel: {},
  hasMoreByChannel: {},
  isLoading: false,
  isLoadingMessages: false,
  replyingTo: null,
  scrollToMessageId: null,
  typingUsers: {},

  fetchChannels: async () => {
    set({ isLoading: true });
    const gen = get().beginUnreadFetch();
    const res = await dmApi.listDMChannels();
    if (!res.success || !res.data) {
      set({ isLoading: false });
      get().applyServerUnread(null, gen);
      return;
    }

    // A server that does not send unread_count has not said the conversation is read — it has
    // said nothing. Treating the gap as zero wipes every badge and purges the notification tray.
    const counts: Record<string, number> = {};
    let serverKnows = true;
    for (const ch of res.data) {
      if (typeof ch.unread_count !== "number") {
        serverKnows = false;
        break;
      }
      if (ch.unread_count > 0) counts[ch.id] = ch.unread_count;
    }

    set({ channels: res.data, isLoading: false });
    get().applyServerUnread(serverKnows ? counts : null, gen);
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

  resyncChannel: async (channelId) => {
    if (useE2EEStore.getState().initStatus !== "ready") return;

    const res = await dmApi.getDMMessages(channelId, undefined, 50);
    if (!res.success || !res.data) return;
    const data = res.data;

    const page = await decryptDMMessages(data.messages ?? []);

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

  sendMessage: async (channelId, content, files, replyToId, upload) => {
    const e2eeState = useE2EEStore.getState();

    const dmChannel = get().channels.find((ch) => ch.id === channelId);
    // Fail closed, same rule as the channel path: an unknown state must not default to plaintext on
    // a conversation that turns out to mandate encryption.
    if (typeof dmChannel?.e2ee_enabled !== "boolean") {
      useToastStore.getState().addToast("error", i18n.t("chat:encryptionStateUnknown"));
      return false;
    }
    if (dmChannel.e2ee_enabled && e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const channel = dmChannel;
      const currentUserId = useAuthStore.getState().user?.id;

      if (channel && currentUserId) {
        try {
          let encryptedFiles: File[] | undefined;
          let thumbs: (import("../utils/imageEncoding").GeneratedThumbnail | null)[] | undefined;
          let fileMetas: import("../crypto/fileEncryption").EncryptedFileMeta[] | undefined;

          if (files && files.length > 0) {
            const result = await encryptFilesForE2EE(files, upload?.signal);
            encryptedFiles = result.files;
            thumbs = result.thumbs;
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

          pushSentPlaintext(channelId, { content, file_keys: fileMetas });

          const res = await dmApi.sendEncryptedDMMessage(
            channelId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata,
            encryptedFiles,
            replyToId,
            upload,
            thumbs
          );

          if (res.success && res.data) {
            try {
              await persistSentPlaintext(res.data.id, channelId, content);
            } catch {
              /* IndexedDB optional */
            }
          }

          if (!res.success) {
            discardLastSentPlaintext(channelId);
            handleSendError(res);
          }

          return res.success;
        } catch (err) {
          discardLastSentPlaintext(channelId);
          // A user-initiated cancel is not a failure — no toast and no red console entry.
          if (err instanceof DOMException && err.name === "AbortError") return false;
          console.error("[dmStore] E2EE encrypt failed:", err);

          // No plaintext fallback: the server refuses unencrypted messages on an encrypted DM, so
          // this only re-uploaded every attachment to earn a second rejection. The problem is the
          // recipient having no device keys, which is what the user is told.
          const errMsg = err instanceof Error ? err.message : "";
          if (errMsg === "RECIPIENT_NO_KEYS") {
            useToastStore.getState().addToast("error", i18n.t("e2ee:recipientNoKeys"));
            return false;
          }
          useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
          return false;
        }
      }
    }

    // Same generation as the encrypted path, so both produce previews identically.
    const plainThumbs = files
      ? await mapWithConcurrency(files, PREVIEW_CONCURRENCY, (file) =>
          buildAttachmentPreview(file, upload?.signal)
        )
      : undefined;
    const res = await dmApi.sendDMMessage(channelId, content, files, replyToId, upload, plainThumbs);
    handleSendError(res);
    return res.success;
  },

  editMessage: async (messageId, content) => {
    const e2eeState = useE2EEStore.getState();

    const editState = get();
    let recipientUserId: string | null = null;
    // undefined until a channel is found — the message may not be cached (edited from search or
    // pins) or the channel list may not have arrived. Defaulting to false attempted a plaintext
    // edit on an encrypted conversation, same fail-open sendMessage was hardened against.
    let editChannelE2EE: boolean | undefined;
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

    if (typeof editChannelE2EE !== "boolean") {
      useToastStore.getState().addToast("error", i18n.t("chat:encryptionStateUnknown"));
      return false;
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

          cacheEditPlaintext(messageId, { content });

          const res = await dmApi.editEncryptedDMMessage(
            messageId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata
          );

          if (res.success) {
            persistSentPlaintext(messageId, "", content).catch(() => {});
          }

          return res.success;
        } catch (err) {
          console.error("[dmStore] E2EE edit encrypt failed:", err);
          // Same dead path as sendMessage: a plaintext edit on an encrypted DM is refused.
          const editErrMsg = err instanceof Error ? err.message : "";
          if (editErrMsg === "RECIPIENT_NO_KEYS") {
            useToastStore.getState().addToast("error", i18n.t("e2ee:recipientNoKeys"));
            return false;
          }
          useToastStore.getState().addToast("error", i18n.t("e2ee:encryptionFailed"));
          return false;
        }
      }
    }

    const res = await dmApi.editDMMessage(messageId, content);
    return res.success;
  },

  deleteMessage: async (messageId) => {
    const res = await dmApi.deleteDMMessage(messageId);
    return res.success;
  },

  setReplyingTo: (message) => set({ replyingTo: message }),
  setScrollToMessageId: (id) => set({ scrollToMessageId: id }),

  toggleReaction: async (messageId, _channelId, emoji) => {
    await dmApi.toggleDMReaction(messageId, emoji);
  },

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

  searchMessages: async (channelId, query, limit = 25, offset = 0) => {
    const res = await dmApi.searchDMMessages(channelId, query, limit, offset);
    if (res.success && res.data) {
      return res.data;
    }
    return { messages: [], total_count: 0 };
  },

  acceptDMRequest: async (channelId) => {
    const res = await dmApi.acceptDMRequest(channelId);
    if (res.success) {
      set((state) => ({
        channels: state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, status: "accepted" as const, initiated_by: null } : ch
        ),
      }));
    }
  },

  declineDMRequest: async (channelId) => {
    const res = await dmApi.declineDMRequest(channelId);
    if (res.success) {
      useUIStore.getState().closeDMTab(channelId);
      set((state) => ({
        channels: state.channels.filter((ch) => ch.id !== channelId),
        selectedDMId: state.selectedDMId === channelId ? null : state.selectedDMId,
      }));
    }
  },

  toggleE2EE: async (channelId, enabled) => {
    const res = await dmApi.toggleDME2EE(channelId, enabled);
    if (res.success && res.data) {
      set((state) => ({
        channels: state.channels.map((ch) =>
          ch.id === channelId ? { ...ch, e2ee_enabled: enabled } : ch
        ),
      }));
      if (enabled) {
        useE2EEStore.getState().checkAndPromptRecovery();
      }
    }
    return res.success;
  },

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
