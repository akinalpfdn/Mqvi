/**
 * Outbox — messages this device sent that the server has not confirmed yet.
 *
 * Kept apart from the message stores on purpose: everything that reads messagesByChannel (mark-read,
 * the resync page merge, paging, reactions, pins) treats each entry as a stored message with a
 * server id. A pending message has neither, only the client nonce that makes its send idempotent.
 *
 * The stores own what a send is (encryption, endpoint, confirmation); this module owns how it is
 * run: one send at a time per conversation so order holds, a timeout so a dead connection fails
 * instead of hanging, and cancel.
 */

import { create } from "zustand";
import type { UploadOptions } from "../api/client";
import type { E2EEPayload } from "../crypto/e2eePayload";
import type { EncryptedFileMeta } from "../crypto/fileEncryption";
import type { GeneratedThumbnail } from "../utils/imageEncoding";
import type { MessageReference } from "../types";

/** No answer, a timeout or a 5xx: the server may be fine later, so an unattended retry is safe. */
export type PendingFailure = "transient" | "rejected";

export type PendingAttachment = {
  filename: string;
  /** Object URL of the local file — revoked when the entry leaves the outbox. */
  file_url: string;
  file_size: number;
  mime_type: string;
};

export type PendingMessage = {
  nonce: string;
  kind: "channel" | "dm";
  conversationId: string;
  /** Channel sends only: the server the channel belongs to. */
  serverId?: string;
  content: string;
  files: File[];
  attachments: PendingAttachment[];
  replyToId: string | null;
  referencedMessage: MessageReference | null;
  createdAt: string;
  status: "sending" | "failed";
  failure: PendingFailure | null;
  /** Came back from the device cache without its files (there was no room for them). */
  filesLost?: boolean;
};

export type PendingProgress = { loaded: number; total: number | null };

/**
 * What an attempt sends, built on the first attempt and reused by every retry: a retry repeats the
 * request the server may already have stored, rather than encrypting the message a second time.
 */
export type PreparedSend = {
  thumbs?: (GeneratedThumbnail | null)[];
  /** Absent for a plaintext send. */
  encrypted?: {
    ciphertext: string;
    metadata: string;
    deviceId: string;
    files?: File[];
    fileMetas?: EncryptedFileMeta[];
  };
};

type OutboxState = {
  pendingByConversation: Record<string, PendingMessage[]>;
  /** Apart from the list so an upload tick re-renders its own row, not the whole conversation. */
  progressByNonce: Record<string, PendingProgress>;

  add: (entry: PendingMessage) => void;
  setStatus: (nonce: string, status: PendingMessage["status"], failure: PendingFailure | null) => void;
  setProgress: (nonce: string, progress: PendingProgress | null) => void;
  /** Drops the entry and frees its previews. A no-op for a nonce no longer here. */
  remove: (nonce: string) => void;
  find: (nonce: string) => PendingMessage | undefined;
};

/** Out of state: it never renders, and holds encrypted copies of every attached file. */
const preparedByNonce = new Map<string, PreparedSend>();

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function revokePreviews(entry: PendingMessage): void {
  for (const att of entry.attachments) URL.revokeObjectURL(att.file_url);
}

export const useOutboxStore = create<OutboxState>((set, get) => ({
  pendingByConversation: {},
  progressByNonce: {},

  add: (entry) => {
    set((state) => ({
      pendingByConversation: {
        ...state.pendingByConversation,
        [entry.conversationId]: [...(state.pendingByConversation[entry.conversationId] ?? []), entry],
      },
    }));
  },

  setStatus: (nonce, status, failure) => {
    const entry = get().find(nonce);
    if (!entry || (entry.status === status && entry.failure === failure)) return;
    set((state) => ({
      pendingByConversation: {
        ...state.pendingByConversation,
        [entry.conversationId]: state.pendingByConversation[entry.conversationId].map((p) =>
          p.nonce === nonce ? { ...p, status, failure } : p
        ),
      },
    }));
  },

  setProgress: (nonce, progress) => {
    set((state) => {
      if (progress) return { progressByNonce: { ...state.progressByNonce, [nonce]: progress } };
      if (!(nonce in state.progressByNonce)) return state;
      return { progressByNonce: without(state.progressByNonce, nonce) };
    });
  },

  remove: (nonce) => {
    preparedByNonce.delete(nonce);
    const entry = get().find(nonce);
    if (!entry) return;
    revokePreviews(entry);
    set((state) => {
      const left = state.pendingByConversation[entry.conversationId].filter((p) => p.nonce !== nonce);
      return {
        pendingByConversation: left.length > 0
          ? { ...state.pendingByConversation, [entry.conversationId]: left }
          : without(state.pendingByConversation, entry.conversationId),
        progressByNonce: without(state.progressByNonce, nonce),
      };
    });
  },

  find: (nonce) => {
    for (const list of Object.values(get().pendingByConversation)) {
      const hit = list.find((p) => p.nonce === nonce);
      if (hit) return hit;
    }
    return undefined;
  },
}));

export function getPrepared(nonce: string): PreparedSend | undefined {
  return preparedByNonce.get(nonce);
}

export function setPrepared(nonce: string, prepared: PreparedSend): void {
  // Only while the message is still waiting: one discarded mid-encryption must not leave its
  // ciphertext and file copies behind.
  if (useOutboxStore.getState().find(nonce)) preparedByNonce.set(nonce, prepared);
}

/**
 * The text of this device's own pending encrypted send. The sender cannot decrypt its own DM
 * echo (no ratchet session to itself), so the echo, which carries the nonce, reads it from here.
 */
export function sentPayload(nonce: string | undefined): E2EEPayload | null {
  if (!nonce) return null;
  const entry = useOutboxStore.getState().find(nonce);
  if (!entry) return null;
  return { content: entry.content, file_keys: preparedByNonce.get(nonce)?.encrypted?.fileMetas };
}

// ─── Delivery ───

/** A text send that has had no answer by now is treated as lost. */
export const SEND_TIMEOUT_MS = 15_000;
/** An upload that moves no bytes for this long is stalled. */
export const UPLOAD_IDLE_TIMEOUT_MS = 30_000;
/** Once every byte is up the server still scans and stores the files before it answers. */
export const UPLOAD_RESPONSE_TIMEOUT_MS = 120_000;

export type SendOutcome = "sent" | "transient" | "rejected";

export type AttemptContext = {
  /** Aborted on timeout or cancel. Check it before each network step. */
  signal: AbortSignal;
  /** For a multipart send: its progress feeds the bubble and the stall timer. */
  upload: UploadOptions;
};

/** One attempt at the send. "sent" means it already put the stored message in place. */
export type SendAttempt = (ctx: AttemptContext) => Promise<SendOutcome>;

type ActiveAttempt = { controller: AbortController; cancelled: boolean };

const activeAttempts = new Map<string, ActiveAttempt>();

/** Per-conversation tail: a send starts only after the one before it settled, so order holds. */
const conversationChains = new Map<string, Promise<void>>();

function whenAborted(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve("aborted");
    else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
}

async function runAttempt(nonce: string, attempt: SendAttempt, onCancelled: () => void): Promise<void> {
  const outbox = useOutboxStore.getState();
  const entry = outbox.find(nonce);
  if (!entry) return; // discarded or confirmed by its echo while it waited its turn

  const active: ActiveAttempt = { controller: new AbortController(), cancelled: false };
  activeAttempts.set(nonce, active);
  const { controller } = active;

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  const hasFiles = entry.files.length > 0;
  arm(hasFiles ? UPLOAD_IDLE_TIMEOUT_MS : SEND_TIMEOUT_MS);

  const upload: UploadOptions = {
    signal: controller.signal,
    onProgress: (loaded, total) => {
      useOutboxStore.getState().setProgress(nonce, { loaded, total });
      arm(total !== null && loaded >= total ? UPLOAD_RESPONSE_TIMEOUT_MS : UPLOAD_IDLE_TIMEOUT_MS);
    },
  };
  if (hasFiles) outbox.setProgress(nonce, { loaded: 0, total: null });

  let outcome: SendOutcome | "aborted";
  try {
    // Raced against the abort: a step that ignores the signal (a prekey fetch on a dead
    // connection) must not keep the bubble spinning and the conversation's queue blocked.
    outcome = await Promise.race([attempt({ signal: controller.signal, upload }), whenAborted(controller.signal)]);
  } catch (err) {
    console.error("[outbox] send attempt failed:", err);
    outcome = "rejected";
  } finally {
    clearTimeout(timer);
    if (activeAttempts.get(nonce) === active) activeAttempts.delete(nonce);
    useOutboxStore.getState().setProgress(nonce, null);
  }

  if (active.cancelled) {
    onCancelled();
    return;
  }
  // Gone means its echo or this attempt confirmed it.
  if (outcome === "sent" || !useOutboxStore.getState().find(nonce)) return;
  const failure: PendingFailure = timedOut || outcome === "aborted" || outcome === "transient" ? "transient" : "rejected";
  // A refusal means nothing was stored, so the next try may be built afresh — and must be, when
  // what was refused is the request itself (encrypted for a conversation that turned plaintext).
  // Only a lost answer has to repeat the exact request the server may hold.
  if (failure === "rejected") preparedByNonce.delete(nonce);
  useOutboxStore.getState().setStatus(nonce, "failed", failure);
}

/**
 * Queues an attempt behind the conversation's earlier sends. onCancelled runs when the user
 * cancelled it mid-flight; the caller owns that cleanup. Resolves once this attempt has settled.
 */
export function startDelivery(nonce: string, attempt: SendAttempt, onCancelled: () => void): Promise<void> {
  const outbox = useOutboxStore.getState();
  const entry = outbox.find(nonce);
  if (!entry || activeAttempts.has(nonce)) return Promise.resolve();
  outbox.setStatus(nonce, "sending", null);

  const previous = conversationChains.get(entry.conversationId) ?? Promise.resolve();
  const next = previous.then(() => runAttempt(nonce, attempt, onCancelled));
  conversationChains.set(entry.conversationId, next);
  void next.finally(() => {
    if (conversationChains.get(entry.conversationId) === next) conversationChains.delete(entry.conversationId);
  });
  return next;
}

/** Aborts a running attempt as a cancel. False when nothing was in flight for this nonce. */
export function cancelDelivery(nonce: string): boolean {
  const active = activeAttempts.get(nonce);
  if (!active) return false;
  active.cancelled = true;
  active.controller.abort();
  return true;
}

/**
 * Lost answers and server errors are worth retrying unattended. Anything else the server answered
 * is not — 429 included: the user was told they sent too fast, and the message going out on its own
 * at some later reconnect would surprise them.
 */
export function classifyFailure(httpStatus: number | undefined): Exclude<SendOutcome, "sent"> {
  if (httpStatus === undefined || httpStatus === 0 || httpStatus === 408 || httpStatus >= 500) {
    return "transient";
  }
  return "rejected";
}

/** Builds the local previews a pending bubble shows for its files. */
export function previewAttachments(files: File[]): PendingAttachment[] {
  return files.map((file) => ({
    filename: file.name,
    file_url: URL.createObjectURL(file),
    file_size: file.size,
    mime_type: file.type,
  }));
}

/** Failed text sends that may be retried unattended, oldest first. Files wait for the user. */
export function autoRetryable(kind: PendingMessage["kind"]): PendingMessage[] {
  const all = Object.values(useOutboxStore.getState().pendingByConversation).flat();
  return all
    .filter((p) => p.kind === kind && p.status === "failed" && p.failure === "transient" && p.files.length === 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Drops every pending message, aborting what is in flight. For sign-out: left in place, the next
 * account to sign in on this device would retry them under its own session.
 */
export function resetOutbox(): void {
  for (const [nonce, active] of activeAttempts) {
    active.cancelled = true;
    active.controller.abort();
    activeAttempts.delete(nonce);
  }
  for (const list of Object.values(useOutboxStore.getState().pendingByConversation)) {
    for (const entry of list) revokePreviews(entry);
  }
  preparedByNonce.clear();
  useOutboxStore.setState({ pendingByConversation: {}, progressByNonce: {} });
}
