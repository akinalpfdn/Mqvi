import { create } from "zustand";
import i18n from "../i18n";
import * as dmApi from "../api/dm";
import type { DMSearchResult } from "../api/dm";
import type { UploadOptions } from "../api/client";
import { buildAttachmentPreview } from "../utils/attachmentPreview";
import { mapWithConcurrency } from "../utils/concurrency";
import { PREVIEW_CONCURRENCY } from "../utils/constants";
import type { DMChannelWithUser, DMMessage, MessageReference } from "../types";
import { useUIStore } from "./uiStore";
import { useToastStore } from "./toastStore";
import { useE2EEStore, canEncrypt } from "./e2eeStore";
import { useAuthStore } from "./authStore";
import {
  encryptDMMessage,
  decryptDMMessages,
  persistSentPlaintext,
  cacheEditPlaintext,
} from "../crypto/dmEncryption";
import { encodePayload } from "../crypto/e2eePayload";
import { mergeLatestPage, resyncLimit, withFlag } from "../utils/messageSync";
import { randomId } from "../utils/randomId";
import {
  useOutboxStore,
  startDelivery,
  cancelDelivery,
  previewAttachments,
  autoRetryable,
  getPrepared,
  setPrepared,
  type PreparedSend,
  type SendAttempt,
} from "./outboxStore";
import {
  encryptFilesForE2EE,
  encryptedEditPayload,
  sendFailureOutcome,
  encryptionFailureOutcome,
} from "./shared/messageUtils";
import {
  createDMSettingsSlice,
  type DMSettingsSlice,
} from "./slices/dmSettingsSlice";
import {
  createDMWsSlice,
  type DMWsSlice,
} from "./slices/dmWsSlice";

/**
 * Bumped by invalidateFetchCache. A fetch that started before the bump decrypted its page under
 * key state that no longer applies — without this it would land on top of the refill and put the
 * placeholders back. Mirrors messageStore.
 */
let cacheGeneration = 0;

/** DMs showing what the device cache held, not yet checked against the server — see messageStore. */
const staleChannels = new Set<string>();

const EMPTY_CHANNELS: DMChannelWithUser[] = [];
const EMPTY_MESSAGES: DMMessage[] = [];
const EMPTY_STRINGS: string[] = [];

type DMCoreState = {
  channels: DMChannelWithUser[];
  selectedDMId: string | null;
  messagesByChannel: Record<string, DMMessage[]>;
  hasMoreByChannel: Record<string, boolean>;
  isLoading: boolean;
  /** Per conversation, like messageStore: first page in flight, and an older page in flight. */
  loadingByChannel: Record<string, true>;
  loadingMoreByChannel: Record<string, true>;

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
  /** Same contract as messageStore.sendMessage: true once queued, false only when refused up front. */
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string, upload?: UploadOptions) => Promise<boolean>;
  /**
   * For a caller with no bubble to watch (inviting friends from a modal): resolves once delivery
   * settled, true only if the server stored it. A failure stays in that conversation's outbox.
   */
  sendMessageAndWait: (channelId: string, content: string) => Promise<boolean>;
  retryPending: (nonce: string) => void;
  discardPending: (nonce: string) => void;
  retryFailedSends: () => void;
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
  /** Same as messageStore.hydrateConversation. */
  hydrateConversation: (channelId: string, messages: DMMessage[], hasMore: boolean) => void;
  resyncIfStale: (channelId: string) => Promise<void>;
};

export type DMStore = DMCoreState & DMSettingsSlice & DMWsSlice;

/**
 * Whether a DM goes out encrypted, or why it cannot go out. Fails closed like the channel path: an
 * unknown state must not default to plaintext on a conversation that mandates encryption.
 */
function dmSendMode(channel: DMChannelWithUser | undefined): "plaintext" | "e2ee" | { refusal: string } {
  if (typeof channel?.e2ee_enabled !== "boolean") return { refusal: "chat:encryptionStateUnknown" };
  if (!channel.e2ee_enabled) return "plaintext";
  if (!canEncrypt(useE2EEStore.getState()) || !useAuthStore.getState().user?.id) {
    return { refusal: "chat:encryptionRequired" };
  }
  return "e2ee";
}

async function prepareDMSend(
  mode: "plaintext" | "e2ee",
  recipientUserId: string,
  content: string,
  files: File[],
  signal: AbortSignal
): Promise<PreparedSend> {
  if (mode === "plaintext") {
    const thumbs = files.length > 0
      ? await mapWithConcurrency(files, PREVIEW_CONCURRENCY, (file) => buildAttachmentPreview(file, signal))
      : undefined;
    return { thumbs };
  }

  const { localDeviceId } = useE2EEStore.getState();
  const userId = useAuthStore.getState().user?.id;
  if (!localDeviceId || !userId) throw new Error("E2EE device not ready");

  let encrypted: Awaited<ReturnType<typeof encryptFilesForE2EE>> | undefined;
  if (files.length > 0) encrypted = await encryptFilesForE2EE(files, signal);

  // No plaintext fallback on failure: the server refuses unencrypted messages on an encrypted DM.
  const envelopes = await encryptDMMessage(userId, recipientUserId, localDeviceId, encodePayload(content, encrypted?.metas));
  return {
    thumbs: encrypted?.thumbs,
    encrypted: {
      ciphertext: JSON.stringify(envelopes),
      metadata: JSON.stringify({}),
      deviceId: localDeviceId,
      files: encrypted?.files,
      fileMetas: encrypted?.metas,
    },
  };
}

function dmAttempt(nonce: string): SendAttempt {
  return async ({ signal, upload }) => {
    const entry = useOutboxStore.getState().find(nonce);
    if (!entry) return "rejected";
    const channelId = entry.conversationId;

    let prepared = getPrepared(nonce);
    if (!prepared) {
      const channel = useDMStore.getState().channels.find((ch) => ch.id === channelId);
      const mode = dmSendMode(channel);
      if (typeof mode === "object") {
        useToastStore.getState().addToast("error", i18n.t(mode.refusal));
        return "rejected";
      }
      try {
        // dmSendMode answers "e2ee" only for a channel it found.
        prepared = await prepareDMSend(mode, channel?.other_user.id ?? "", entry.content, entry.files, signal);
      } catch (err) {
        return encryptionFailureOutcome(err, "dmStore");
      }
      setPrepared(nonce, prepared);
    }
    if (signal.aborted) return "transient";

    const replyToId = entry.replyToId ?? undefined;
    const sealed = prepared.encrypted;
    const res = sealed
      ? await dmApi.sendEncryptedDMMessage(
          channelId, sealed.ciphertext, sealed.deviceId, sealed.metadata,
          sealed.files, replyToId, upload, prepared.thumbs, nonce
        )
      : await dmApi.sendDMMessage(channelId, entry.content, entry.files, replyToId, upload, prepared.thumbs, nonce);

    if (!res.success) return sendFailureOutcome(res);
    if (res.data) {
      let stored: DMMessage = { ...res.data, client_nonce: nonce };
      if (sealed) {
        stored = { ...stored, content: entry.content, e2ee_file_keys: sealed.fileMetas };
        // Before the pending copy goes: an echo landing after that finds neither the outbox entry
        // nor, for a conversation that is not loaded, a stored copy — only this.
        try {
          await persistSentPlaintext(res.data.id, channelId, entry.content, sealed.fileMetas);
        } catch {
          /* IndexedDB optional */
        }
      }
      useDMStore.getState().handleDMMessageCreate(stored);
    }
    useOutboxStore.getState().remove(nonce);
    return "sent";
  };
}

/** Puts a DM in the outbox; null when it was refused up front, so the composer keeps the text. */
function queueDMSend(channelId: string, content: string, files: File[], replyToId: string | undefined): string | null {
  const state = useDMStore.getState();
  const mode = dmSendMode(state.channels.find((ch) => ch.id === channelId));
  if (typeof mode === "object") {
    useToastStore.getState().addToast("error", i18n.t(mode.refusal));
    return null;
  }

  const nonce = randomId();
  useOutboxStore.getState().add({
    nonce,
    kind: "dm",
    conversationId: channelId,
    content,
    files,
    attachments: previewAttachments(files),
    replyToId: replyToId ?? null,
    referencedMessage: referenceFor(state.messagesByChannel[channelId], replyToId),
    createdAt: new Date().toISOString(),
    status: "sending",
    failure: null,
  });
  return nonce;
}

function deliverDM(nonce: string): Promise<void> {
  return startDelivery(nonce, dmAttempt(nonce), () => useOutboxStore.getState().remove(nonce));
}

function referenceFor(messages: DMMessage[] | undefined, replyToId: string | undefined): MessageReference | null {
  if (!replyToId) return null;
  const target = messages?.find((m) => m.id === replyToId);
  return target ? { id: target.id, author: target.author, content: target.content } : null;
}


export const useDMStore = create<DMStore>((set, get, store) => ({
  ...createDMSettingsSlice(set, get, store),
  ...createDMWsSlice(set, get, store),

  channels: EMPTY_CHANNELS,
  selectedDMId: null,
  messagesByChannel: {},
  hasMoreByChannel: {},
  isLoading: false,
  loadingByChannel: {},
  loadingMoreByChannel: {},
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
    if (staleChannels.has(channelId)) {
      await get().resyncChannel(channelId);
      return;
    }
    // In flight counts too: two mounts racing each fetched and the slower one overwrote the other.
    if (get().messagesByChannel[channelId] || get().loadingByChannel[channelId]) return;

    // No E2EE gate. Blocking the whole fetch until init was ready meant a plaintext conversation
    // rendered empty for as long as E2EE was still starting — and forever if init ended in error.
    // decryptDMMessages leaves placeholders for what it cannot read yet, and refillAfterKeysReady
    // refetches once the keys land. Matches messageStore.fetchMessages.
    set((state) => ({ loadingByChannel: withFlag(state.loadingByChannel, channelId, true) }));
    try {
      const generation = cacheGeneration;
      const res = await dmApi.getDMMessages(channelId, undefined, 50);
      if (!res.success || !res.data) return;
      const data = res.data;
      const messages = await decryptDMMessages(data.messages ?? []);

      // Invalidated while in flight — this page predates the keys. Let the refill's fetch win.
      if (generation !== cacheGeneration) return;

      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: messages,
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: data.has_more,
        },
      }));
    } finally {
      set((state) => ({ loadingByChannel: withFlag(state.loadingByChannel, channelId, false) }));
    }
  },

  resyncChannel: async (channelId) => {
    const generation = cacheGeneration;
    const held = get().messagesByChannel[channelId]?.length ?? 0;
    const res = await dmApi.getDMMessages(channelId, undefined, resyncLimit(held));
    if (!res.success || !res.data) return;
    const data = res.data;

    // Folding placeholders into the held cache would hide real content behind them, and unlike
    // the mount-time fetch there is nothing to invalidate afterwards. Leave the cache alone and
    // let refillAfterKeysReady cover it. Matches messageStore.resyncChannel.
    const raw = data.messages ?? [];
    if (
      useE2EEStore.getState().initStatus !== "ready" &&
      raw.some((m) => m.encryption_version === 1)
    ) {
      return;
    }

    const page = await decryptDMMessages(raw);

    // Keys changed mid-flight — the page would win on id and undo the refill. Same guard as
    // messageStore.resyncChannel.
    if (generation !== cacheGeneration) return;
    staleChannels.delete(channelId);

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
    // Every scroll event near the top calls this. Without the guard each one refetched the same
    // page while the first was in flight: duplicates prepended, and an encrypted page decrypted
    // twice fails — a received message's ratchet key is spent on the first decrypt.
    if (get().loadingMoreByChannel[channelId]) return;

    set((state) => ({ loadingMoreByChannel: withFlag(state.loadingMoreByChannel, channelId, true) }));
    try {
      const generation = cacheGeneration;
      const beforeId = messages[0].id;
      const res = await dmApi.getDMMessages(channelId, beforeId, 50);
      if (!res.success || !res.data) return;
      const data = res.data;
      const decrypted = await decryptDMMessages(data.messages);

      // The keys changed while this was in flight: the page was decrypted under the old ones, and
      // the refill that followed already holds what the conversation shows now.
      if (generation !== cacheGeneration) return;

      set((state) => {
        const held = state.messagesByChannel[channelId];
        // The page continues the list it was requested from. Emptied or refetched meanwhile, the
        // list no longer starts there, and prepending would throw or leave a hidden gap.
        if (held?.[0]?.id !== beforeId) return state;
        return {
          messagesByChannel: { ...state.messagesByChannel, [channelId]: [...decrypted, ...held] },
          hasMoreByChannel: { ...state.hasMoreByChannel, [channelId]: data.has_more },
        };
      });
    } finally {
      set((state) => ({ loadingMoreByChannel: withFlag(state.loadingMoreByChannel, channelId, false) }));
    }
  },

  sendMessage: async (channelId, content, files, replyToId) => {
    const nonce = queueDMSend(channelId, content, files ?? [], replyToId);
    if (!nonce) return false;
    void deliverDM(nonce);
    return true;
  },

  sendMessageAndWait: async (channelId, content) => {
    const nonce = queueDMSend(channelId, content, [], undefined);
    if (!nonce) return false;
    await deliverDM(nonce);
    return !useOutboxStore.getState().find(nonce);
  },

  retryPending: (nonce) => {
    void deliverDM(nonce);
  },

  discardPending: (nonce) => {
    if (!cancelDelivery(nonce)) useOutboxStore.getState().remove(nonce);
  },

  retryFailedSends: () => {
    for (const entry of autoRetryable("dm")) get().retryPending(entry.nonce);
  },

  editMessage: async (messageId, content) => {
    const e2eeState = useE2EEStore.getState();

    const editState = get();
    let recipientUserId: string | null = null;
    // undefined until a channel is found — the message may not be cached (edited from search or
    // pins) or the channel list may not have arrived. Defaulting to false attempted a plaintext
    // edit on an encrypted conversation, same fail-open sendMessage was hardened against.
    let editChannelE2EE: boolean | undefined;
    let editChannelId: string | null = null;
    let held: DMMessage | undefined;
    for (const [chId, msgs] of Object.entries(editState.messagesByChannel)) {
      held = msgs.find((m) => m.id === messageId);
      if (held) {
        editChannelId = chId;
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

    if (editChannelE2EE && !canEncrypt(e2eeState)) {
      useToastStore.getState().addToast("error", i18n.t("chat:encryptionRequired"));
      return false;
    }

    if (editChannelE2EE && e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const currentUserId = useAuthStore.getState().user?.id;

      if (recipientUserId && currentUserId) {
        const plaintext = encryptedEditPayload(content, held);
        if (plaintext === null) {
          useToastStore.getState().addToast("error", i18n.t("e2ee:editAttachmentKeysMissing"));
          return false;
        }
        try {
          const envelopes = await encryptDMMessage(
            currentUserId,
            recipientUserId,
            e2eeState.localDeviceId,
            plaintext
          );

          const ciphertext = JSON.stringify(envelopes);
          const metadata = JSON.stringify({});

          cacheEditPlaintext(messageId, { content, file_keys: held?.e2ee_file_keys });

          const res = await dmApi.editEncryptedDMMessage(
            messageId,
            ciphertext,
            e2eeState.localDeviceId,
            metadata
          );

          if (res.success) {
            // Under its conversation, or DM search (which filters by it) stops finding it.
            persistSentPlaintext(messageId, editChannelId ?? "", content, held?.e2ee_file_keys).catch(() => {});
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
    cacheGeneration++;
    staleChannels.clear();
    set({ messagesByChannel: {}, hasMoreByChannel: {} });
  },

  hydrateConversation: (channelId, messages, hasMore) => {
    if (get().messagesByChannel[channelId]) return;
    staleChannels.add(channelId);
    set((state) => ({
      messagesByChannel: { ...state.messagesByChannel, [channelId]: messages },
      hasMoreByChannel: { ...state.hasMoreByChannel, [channelId]: hasMore },
    }));
  },

  resyncIfStale: async (channelId) => {
    if (staleChannels.has(channelId)) await get().resyncChannel(channelId);
  },
}));
