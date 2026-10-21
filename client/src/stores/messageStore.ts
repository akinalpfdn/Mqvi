/**
 * Message Store — Channel message state management.
 */

import { create } from "zustand";
import i18n from "../i18n";
import * as messageApi from "../api/messages";
import * as reactionApi from "../api/reactions";
import type { UploadOptions } from "../api/client";
import { buildAttachmentPreview } from "../utils/attachmentPreview";
import { mapWithConcurrency } from "../utils/concurrency";
import { PREVIEW_CONCURRENCY } from "../utils/constants";
import { useServerStore, selectServerE2EE } from "./serverStore";
import { useE2EEStore, canEncrypt } from "./e2eeStore";
import { useAuthStore } from "./authStore";
import { useReadStateStore } from "./readStateStore";
import { useToastStore } from "./toastStore";
import { encryptChannelMessage, decryptChannelMessages } from "../crypto/channelEncryption";
import { encodePayload } from "../crypto/e2eePayload";
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
import type { Message, MessageReference, ReactionGroup } from "../types";
import { DEFAULT_MESSAGE_LIMIT } from "../utils/constants";
import { mergeLatestPage, resyncLimit, withFlag } from "../utils/messageSync";
import {
  encryptFilesForE2EE,
  encryptedEditPayload,
  sendFailureOutcome,
  encryptionFailureOutcome,
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
  /**
   * Conversations whose first page is in flight, and those loading an older page. Per conversation:
   * one shared flag put the skeleton over every open conversation while any one of them loaded.
   */
  loadingByChannel: Record<string, true>;
  loadingMoreByChannel: Record<string, true>;
  /** channelId -> username[] */
  typingUsers: Record<string, string[]>;

  // ─── Reply State ───
  replyingTo: Message | null;
  scrollToMessageId: string | null;

  // ─── Actions ───
  fetchMessages: (channelId: string, serverId?: string) => Promise<void>;
  fetchOlderMessages: (channelId: string, serverId?: string) => Promise<void>;
  /**
   * Re-fetch the newest page and fold it in — recovers messages a dead socket never delivered.
   * `markRead` must be false for a tab the user is not looking at, or reconnecting clears the
   * badge on every open tab at once.
   */
  resyncChannel: (channelId: string, serverId?: string, opts?: { markRead?: boolean }) => Promise<void>;
  /** Clear fetch cache — forces re-fetch + re-decrypt (E2EE restore) */
  invalidateFetchCache: () => void;
  /**
   * Checks the message can go out, puts it in the outbox and starts delivering it. True once it is
   * queued — delivery reports through the outbox. False only when it was refused up front.
   */
  sendMessage: (channelId: string, content: string, files?: File[], replyToId?: string, serverId?: string, upload?: UploadOptions) => Promise<boolean>;
  /** Sends a pending message again, under the nonce it already has. */
  retryPending: (nonce: string) => void;
  /** Cancels a pending message, aborting its upload if one is running. */
  discardPending: (nonce: string) => void;
  /** Retries every failed text send that may be retried unattended — after a reconnect. */
  retryFailedSends: () => void;
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

/**
 * Bumped by invalidateFetchCache. A fetch that started before the bump decrypted its page under
 * key state that no longer applies — without this it would land on top of the refill and put the
 * placeholders back.
 */
let cacheGeneration = 0;

/**
 * Channels with a fetch in flight. `fetchedChannels` cannot serve this: it is only set once the
 * response is decrypted and accepted, so between entry and that point a second caller passes the
 * guard and repeats the whole request. Refill now fans out over every open tab, which makes an
 * overlap with a mounting MessageList easy to hit.
 */
const inFlightChannels = new Set<string>();

/**
 * Whether a message to this server goes out encrypted, or why it cannot go out at all.
 *
 * The flag is read for the server the message goes to, not the active one: a tab can hold a
 * channel of a non-active server. Unknown state fails closed — guessing "not encrypted" would send
 * plaintext to a server that mandates encryption.
 */
function channelSendMode(serverId: string): "plaintext" | "e2ee" | { refusal: string } {
  const e2ee = selectServerE2EE(serverId)(useServerStore.getState());
  if (e2ee === undefined) return { refusal: "chat:encryptionStateUnknown" };
  if (!e2ee) return "plaintext";
  // Encrypted target, device not ready: refuse rather than fall through to plaintext. The server
  // would reject it anyway, but with the wrong reason.
  if (!canEncrypt(useE2EEStore.getState()) || !useAuthStore.getState().user?.id) {
    return { refusal: "chat:encryptionRequired" };
  }
  return "e2ee";
}

async function prepareChannelSend(
  mode: "plaintext" | "e2ee",
  channelId: string,
  content: string,
  files: File[],
  signal: AbortSignal
): Promise<PreparedSend> {
  if (mode === "plaintext") {
    // Previews are generated here, not in the api layer, so both paths produce them the same way.
    // Non-images and already-small files come back null.
    const thumbs = files.length > 0
      ? await mapWithConcurrency(files, PREVIEW_CONCURRENCY, (file) => buildAttachmentPreview(file, signal))
      : undefined;
    return { thumbs };
  }

  const { localDeviceId } = useE2EEStore.getState();
  const userId = useAuthStore.getState().user?.id;
  // channelSendMode checked both moments ago; they can only have gone with a sign-out.
  if (!localDeviceId || !userId) throw new Error("E2EE device not ready");

  let encrypted: Awaited<ReturnType<typeof encryptFilesForE2EE>> | undefined;
  if (files.length > 0) encrypted = await encryptFilesForE2EE(files, signal);

  const senderKeyMsg = await encryptChannelMessage(
    channelId,
    userId,
    localDeviceId,
    encodePayload(content, encrypted?.metas)
  );
  return {
    thumbs: encrypted?.thumbs,
    encrypted: {
      ciphertext: JSON.stringify(senderKeyMsg),
      metadata: JSON.stringify({ distribution_id: senderKeyMsg.distributionId }),
      deviceId: localDeviceId,
      files: encrypted?.files,
      fileMetas: encrypted?.metas,
    },
  };
}

function channelAttempt(nonce: string): SendAttempt {
  return async ({ signal, upload }) => {
    const entry = useOutboxStore.getState().find(nonce);
    if (!entry?.serverId) return "rejected";

    let prepared = getPrepared(nonce);
    if (!prepared) {
      const mode = channelSendMode(entry.serverId);
      if (typeof mode === "object") {
        useToastStore.getState().addToast("error", i18n.t(mode.refusal));
        return "rejected";
      }
      try {
        prepared = await prepareChannelSend(mode, entry.conversationId, entry.content, entry.files, signal);
      } catch (err) {
        return encryptionFailureOutcome(err, "messageStore");
      }
      setPrepared(nonce, prepared);
    }
    if (signal.aborted) return "transient";

    const replyToId = entry.replyToId ?? undefined;
    const sealed = prepared.encrypted;
    const res = sealed
      ? await messageApi.sendEncryptedMessage(
          entry.serverId, entry.conversationId, sealed.ciphertext, sealed.deviceId, sealed.metadata,
          sealed.files, replyToId, upload, prepared.thumbs, nonce
        )
      : await messageApi.sendMessage(
          entry.serverId, entry.conversationId, entry.content, entry.files, replyToId, upload, prepared.thumbs, nonce
        );

    if (!res.success) return sendFailureOutcome(res);
    if (res.data) {
      // The response carries the ciphertext; the sender already has what it says.
      const stored = sealed ? { ...res.data, content: entry.content, e2ee_file_keys: sealed.fileMetas } : res.data;
      useMessageStore.getState().handleMessageCreate({ ...stored, client_nonce: nonce });
    }
    // Without a body the echo delivers it; the pending copy must not outlive the send either way.
    useOutboxStore.getState().remove(nonce);
    return "sent";
  };
}

function referenceFor(messages: Message[] | undefined, replyToId: string | undefined): MessageReference | null {
  if (!replyToId) return null;
  const target = messages?.find((m) => m.id === replyToId);
  return target ? { id: target.id, author: target.author, content: target.content } : null;
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messagesByChannel: {},
  hasMoreByChannel: {},
  loadingByChannel: {},
  loadingMoreByChannel: {},
  typingUsers: {},
  replyingTo: null,
  scrollToMessageId: null,

  invalidateFetchCache: () => {
    cacheGeneration++;
    fetchedChannels.clear();
    set({ messagesByChannel: {}, hasMoreByChannel: {} });
  },

  resyncChannel: async (channelId, explicitServerId?, opts?) => {
    const generation = cacheGeneration;
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return;

    const held = get().messagesByChannel[channelId]?.length ?? 0;
    const res = await messageApi.getMessages(serverId, channelId, undefined, resyncLimit(held));
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

    // The keys changed while this was in flight. mergeLatestPage lets the page win on id, so
    // folding this in would overwrite the freshly refilled content with what the old keys could
    // read — and marking the channel fetched would stop anything from correcting it.
    if (generation !== cacheGeneration) return;

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

    // Only the tab on screen. A background tab is marked read by uiStore.setActiveTab when the
    // user actually switches to it, so nothing is lost by staying quiet here.
    if (opts?.markRead) {
      const merged = get().messagesByChannel[channelId];
      if (merged && merged.length > 0) {
        useReadStateStore.getState().markAsRead(channelId, merged[merged.length - 1].id);
      }
    }
  },

  fetchMessages: async (channelId, explicitServerId?) => {
    if (fetchedChannels.has(channelId) || inFlightChannels.has(channelId)) return;

    const generation = cacheGeneration;
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return;

    inFlightChannels.add(channelId);
    set((state) => ({ loadingByChannel: withFlag(state.loadingByChannel, channelId, true) }));
    try {
      const res = await messageApi.getMessages(serverId, channelId, undefined, DEFAULT_MESSAGE_LIMIT);
      if (!res.success || !res.data) return;
      const data = res.data;
      // Go nil slice -> JSON null; fallback to empty array
      const apiMessages = await decryptChannelMessages(data.messages ?? []);

      // The cache was invalidated while this was in flight — E2EE keys arrived, and this page was
      // decrypted before they did. Dropping it leaves the refill's own fetch to fill the channel.
      if (generation !== cacheGeneration) return;
      fetchedChannels.add(channelId);

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
            [channelId]: data.has_more,
          },
        };
      });

      // Auto-mark-read after messages load
      const allMessages = get().messagesByChannel[channelId];
      if (allMessages && allMessages.length > 0) {
        const lastMsg = allMessages[allMessages.length - 1];
        useReadStateStore.getState().markAsRead(channelId, lastMsg.id);
      }
    } finally {
      // Released on every exit path, or the channel could never be fetched again this session.
      inFlightChannels.delete(channelId);
      set((state) => ({ loadingByChannel: withFlag(state.loadingByChannel, channelId, false) }));
    }
  },

  fetchOlderMessages: async (channelId, explicitServerId?) => {
    const messages = get().messagesByChannel[channelId];
    if (!messages || messages.length === 0) return;
    if (!get().hasMoreByChannel[channelId]) return;
    if (get().loadingMoreByChannel[channelId]) return;

    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return;

    set((state) => ({ loadingMoreByChannel: withFlag(state.loadingMoreByChannel, channelId, true) }));
    try {
      const beforeId = messages[0].id;
      const res = await messageApi.getMessages(serverId, channelId, beforeId, DEFAULT_MESSAGE_LIMIT);
      if (!res.success || !res.data) return;
      const data = res.data;
      const decrypted = await decryptChannelMessages(data.messages ?? []);

      set((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: [...decrypted, ...state.messagesByChannel[channelId]],
        },
        hasMoreByChannel: {
          ...state.hasMoreByChannel,
          [channelId]: data.has_more,
        },
      }));
    } finally {
      set((state) => ({ loadingMoreByChannel: withFlag(state.loadingMoreByChannel, channelId, false) }));
    }
  },

  sendMessage: async (channelId, content, files, replyToId, explicitServerId?) => {
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return false;

    // Refused here, before anything is queued, so the composer keeps what the user wrote. The
    // attempt checks again: encryption state can change while a message waits its turn.
    const mode = channelSendMode(serverId);
    if (typeof mode === "object") {
      useToastStore.getState().addToast("error", i18n.t(mode.refusal));
      return false;
    }

    const nonce = randomId();
    const attached = files ?? [];
    useOutboxStore.getState().add({
      nonce,
      kind: "channel",
      conversationId: channelId,
      serverId,
      content,
      files: attached,
      attachments: previewAttachments(attached),
      replyToId: replyToId ?? null,
      referencedMessage: referenceFor(get().messagesByChannel[channelId], replyToId),
      createdAt: new Date().toISOString(),
      status: "sending",
      failure: null,
    });
    get().retryPending(nonce);
    return true;
  },

  retryPending: (nonce) => {
    startDelivery(nonce, channelAttempt(nonce), () => useOutboxStore.getState().remove(nonce));
  },

  discardPending: (nonce) => {
    // A running attempt finishes the discard through its cancel path, once it has stopped.
    if (!cancelDelivery(nonce)) useOutboxStore.getState().remove(nonce);
  },

  retryFailedSends: () => {
    for (const entry of autoRetryable("channel")) get().retryPending(entry.nonce);
  },

  editMessage: async (messageId, content, explicitServerId?) => {
    const serverId = explicitServerId ?? useServerStore.getState().activeServerId;
    if (!serverId) return false;

    // E2EE encrypted edit
    const e2eeState = useE2EEStore.getState();
    // Same rules as sendMessage: the flag comes from the server being edited in, and an unknown
    // state refuses rather than rewriting an encrypted message as plaintext.
    const editServerE2EE = selectServerE2EE(serverId)(useServerStore.getState());
    if (editServerE2EE === undefined) {
      useToastStore.getState().addToast("error", i18n.t("chat:encryptionStateUnknown"));
      return false;
    }
    if (editServerE2EE && !canEncrypt(e2eeState)) {
      useToastStore.getState().addToast("error", i18n.t("chat:encryptionRequired"));
      return false;
    }
    if (editServerE2EE && e2eeState.initStatus === "ready" && e2eeState.localDeviceId) {
      const currentUserId = useAuthStore.getState().user?.id;
      // Find which channel this message belongs to
      const allChannels = get().messagesByChannel;
      let channelId: string | null = null;
      let held: Message | undefined;
      for (const [chId, msgs] of Object.entries(allChannels)) {
        held = msgs.find((m) => m.id === messageId);
        if (held) {
          channelId = chId;
          break;
        }
      }

      if (currentUserId && channelId) {
        const plaintext = encryptedEditPayload(content, held);
        if (plaintext === null) {
          useToastStore.getState().addToast("error", i18n.t("e2ee:editAttachmentKeysMissing"));
          return false;
        }
        try {
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

      // Duplicate guard. The send response and the echo both land here, whichever comes first;
      // a held copy that could not be decrypted takes the content the later one brings.
      const heldIndex = channelMessages.findIndex((m) => m.id === message.id);
      if (heldIndex !== -1) {
        if (channelMessages[heldIndex].content !== null || message.content === null) return state;
        const next = [...channelMessages];
        next[heldIndex] = message;
        return { messagesByChannel: { ...state.messagesByChannel, [message.channel_id]: next } };
      }

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

    // This device's own send is stored now — its pending copy goes, whichever of response and
    // echo got here first. Only the author's nonce: nobody else can confirm our outbox.
    if (message.client_nonce && message.user_id === useAuthStore.getState().user?.id) {
      useOutboxStore.getState().remove(message.client_nonce);
    }
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
