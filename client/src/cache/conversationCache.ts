/**
 * Conversation cache writer — keeps the 20 most recently opened conversations (channels and DMs in
 * one recency order), each with its newest 100 messages, and the shell (user, servers, channel
 * lists, DM list, unread counts) on the device.
 *
 * Write-through by subscription, not by call sites: every change to a cached conversation's
 * messages — fetch, resync, the socket's create/update/delete, reactions, author updates — goes
 * through the stores, so watching the stores covers paths added later too.
 */

import { useAuthStore } from "../stores/authStore";
import { useMessageStore } from "../stores/messageStore";
import { useDMStore } from "../stores/dmStore";
import { useServerStore } from "../stores/serverStore";
import { useChannelStore } from "../stores/channelStore";
import { useReadStateStore } from "../stores/readStateStore";
import { useOutboxStore, type PendingMessage } from "../stores/outboxStore";
import {
  CACHE_SCHEMA,
  indexedDBBackend,
  type CacheBackend,
  type CachedConversation,
  type CachedPending,
  type CachedShell,
} from "./cacheBackend";
import {
  beginCacheSession,
  cacheEnabled,
  endCacheSession,
  isCurrentPartition,
  partitionFor,
} from "./cacheSession";

export const MAX_CACHED_CONVERSATIONS = 20;
export const MAX_CACHED_MESSAGES = 100;
/** Coalesces a burst (a page, a run of reactions) into one write. */
export const CACHE_WRITE_DELAY_MS = 400;

type ConversationRef =
  | { kind: "channel"; id: string; serverId: string; openedAt: number }
  | { kind: "dm"; id: string; openedAt: number };

type Writer = {
  partition: string;
  backend: CacheBackend;
  /** key → conversation, for the ones in the cache. */
  recent: Map<string, ConversationRef>;
  dirty: Set<string>;
  shellDirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  stopped: boolean;
};

let writer: Writer | null = null;

const conversationKey = (partition: string, kind: string, id: string) => `${partition}|${kind}:${id}`;

function scheduleFlush(w: Writer): void {
  if (w.timer !== undefined || w.stopped) return;
  w.timer = setTimeout(() => {
    w.timer = undefined;
    void flush(w);
  }, CACHE_WRITE_DELAY_MS);
}

function markConversation(w: Writer, key: string): void {
  w.dirty.add(key);
  scheduleFlush(w);
}

/** What the stores hold for a cached conversation, cut to its newest messages. Null until loaded. */
function snapshotConversation(w: Writer, key: string, ref: ConversationRef): CachedConversation | null {
  const base = { key, partition: w.partition, id: ref.id, openedAt: ref.openedAt, schema: CACHE_SCHEMA };
  if (ref.kind === "channel") {
    const state = useMessageStore.getState();
    const messages = state.messagesByChannel[ref.id];
    if (!messages) return null;
    return {
      ...base,
      kind: "channel",
      serverId: ref.serverId,
      messages: messages.slice(-MAX_CACHED_MESSAGES),
      hasMore: messages.length > MAX_CACHED_MESSAGES || (state.hasMoreByChannel[ref.id] ?? false),
    };
  }
  const state = useDMStore.getState();
  const messages = state.messagesByChannel[ref.id];
  if (!messages) return null;
  return {
    ...base,
    kind: "dm",
    messages: messages.slice(-MAX_CACHED_MESSAGES),
    hasMore: messages.length > MAX_CACHED_MESSAGES || (state.hasMoreByChannel[ref.id] ?? false),
  };
}

function snapshotShell(w: Writer): CachedShell | null {
  const user = useAuthStore.getState().user;
  if (!user) return null;
  return {
    partition: w.partition,
    schema: CACHE_SCHEMA,
    user,
    servers: useServerStore.getState().servers,
    categoriesByServer: useChannelStore.getState().categoriesByServer,
    dmChannels: useDMStore.getState().channels,
    unreadCounts: useReadStateStore.getState().unreadCounts,
    dmUnreadCounts: useDMStore.getState().dmUnreadCounts,
  };
}

async function flush(w: Writer): Promise<void> {
  clearTimeout(w.timer);
  w.timer = undefined;
  const stillCurrent = () => !w.stopped && isCurrentPartition(w.partition);
  if (!stillCurrent()) return;

  const keys = [...w.dirty];
  w.dirty.clear();
  const shellDirty = w.shellDirty;
  w.shellDirty = false;

  try {
    for (const key of keys) {
      const ref = w.recent.get(key);
      const snapshot = ref ? snapshotConversation(w, key, ref) : null;
      if (snapshot) await w.backend.putConversation(snapshot, stillCurrent);
    }
    const shell = shellDirty ? snapshotShell(w) : null;
    if (shell) await w.backend.putShell(shell, stillCurrent);
  } catch (err) {
    // A cache that falls behind is refilled by the next change; nothing here is the source of truth.
    console.error("[cache] write failed:", err);
  }
}

function watchMessages(w: Writer): () => void {
  const onChange = (kind: "channel" | "dm") =>
    (state: { messagesByChannel: Record<string, unknown>; hasMoreByChannel: Record<string, boolean> },
     prev: { messagesByChannel: Record<string, unknown>; hasMoreByChannel: Record<string, boolean> }) => {
      if (state.messagesByChannel === prev.messagesByChannel && state.hasMoreByChannel === prev.hasMoreByChannel) return;
      for (const [key, ref] of w.recent) {
        if (ref.kind !== kind) continue;
        if (state.messagesByChannel[ref.id] !== prev.messagesByChannel[ref.id] ||
            state.hasMoreByChannel[ref.id] !== prev.hasMoreByChannel[ref.id]) {
          markConversation(w, key);
        }
      }
    };
  const stops = [useMessageStore.subscribe(onChange("channel")), useDMStore.subscribe(onChange("dm"))];
  return () => stops.forEach((stop) => stop());
}

function watchShell(w: Writer): () => void {
  const mark = () => {
    w.shellDirty = true;
    scheduleFlush(w);
  };
  const stops = [
    useAuthStore.subscribe((s, p) => { if (s.user !== p.user) mark(); }),
    useServerStore.subscribe((s, p) => { if (s.servers !== p.servers) mark(); }),
    useChannelStore.subscribe((s, p) => { if (s.categoriesByServer !== p.categoriesByServer) mark(); }),
    useDMStore.subscribe((s, p) => { if (s.channels !== p.channels || s.dmUnreadCounts !== p.dmUnreadCounts) mark(); }),
    useReadStateStore.subscribe((s, p) => { if (s.unreadCounts !== p.unreadCounts) mark(); }),
  ];
  return () => stops.forEach((stop) => stop());
}

async function storePending(w: Writer, entry: PendingMessage, stillCurrent: () => boolean): Promise<void> {
  const record: CachedPending = {
    key: `${w.partition}|${entry.nonce}`,
    partition: w.partition,
    schema: CACHE_SCHEMA,
    nonce: entry.nonce,
    kind: entry.kind,
    conversationId: entry.conversationId,
    serverId: entry.serverId,
    content: entry.content,
    replyToId: entry.replyToId,
    referencedMessage: entry.referencedMessage,
    createdAt: entry.createdAt,
    files: entry.files,
    filesLost: false,
  };
  try {
    await w.backend.putPending(record, stillCurrent);
  } catch (err) {
    if (entry.files.length === 0) throw err;
    // Most likely the storage quota. Keep the text, and say so rather than lose the message.
    console.error("[cache] could not store a pending message's files:", err);
    await w.backend.putPending({ ...record, files: [], filesLost: true }, stillCurrent);
  }
}

/**
 * Unsent messages, written as soon as they are queued — the app may be killed right after a send —
 * and deleted once confirmed or discarded. One message's writes run in order: a delete overtaking
 * the put before it would leave a confirmed message on disk, to go out again after a restart.
 */
function watchOutbox(w: Writer): () => void {
  const chains = new Map<string, Promise<void>>();
  const stillCurrent = () => !w.stopped && isCurrentPartition(w.partition);
  const run = (nonce: string, op: () => Promise<void>) => {
    const next = (chains.get(nonce) ?? Promise.resolve())
      .then(op)
      .catch((err) => console.error("[cache] outbox write failed:", err));
    chains.set(nonce, next);
    void next.finally(() => { if (chains.get(nonce) === next) chains.delete(nonce); });
  };
  const byNonce = (pending: Record<string, PendingMessage[]>) =>
    new Map(Object.values(pending).flat().map((p) => [p.nonce, p]));

  for (const entry of byNonce(useOutboxStore.getState().pendingByConversation).values()) {
    run(entry.nonce, () => storePending(w, entry, stillCurrent));
  }
  return useOutboxStore.subscribe((state, prev) => {
    if (state.pendingByConversation === prev.pendingByConversation) return;
    const now = byNonce(state.pendingByConversation);
    const before = byNonce(prev.pendingByConversation);
    for (const [nonce, entry] of now) {
      if (!before.has(nonce)) run(nonce, () => storePending(w, entry, stillCurrent));
    }
    for (const nonce of before.keys()) {
      if (!now.has(nonce)) run(nonce, () => w.backend.deletePending(`${w.partition}|${nonce}`));
    }
  });
}

/** The app is leaving the foreground — on mobile it may not come back to a running page. */
function watchLifecycle(w: Writer): () => void {
  const flushNow = () => void flush(w);
  const onVisibility = () => { if (document.visibilityState === "hidden") flushNow(); };
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("pagehide", flushNow);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * Starts the cache for the signed-in user; the returned function stops it. A no-op in a browser.
 * Drops every other partition first: tokens are global, so none of them is a live session.
 */
export function startConversationCache(userId: string, backend: CacheBackend = indexedDBBackend): () => void {
  if (!cacheEnabled()) return () => {};

  const w: Writer = {
    partition: partitionFor(userId),
    backend,
    recent: new Map(),
    dirty: new Set(),
    shellDirty: true,
    timer: undefined,
    stopped: false,
  };
  const unwatch: (() => void)[] = [];
  const stop = () => {
    if (w.stopped) return;
    w.stopped = true;
    clearTimeout(w.timer);
    unwatch.forEach((fn) => fn());
    if (writer === w) writer = null;
    endCacheSession(w.partition);
  };
  beginCacheSession(w.partition, stop);
  writer = w;
  unwatch.push(watchMessages(w), watchShell(w), watchOutbox(w), watchLifecycle(w));
  scheduleFlush(w);

  void (async () => {
    try {
      await backend.clear(w.partition);
      const held = await backend.listConversations(w.partition);
      if (w.stopped) return;
      const stale = held.filter((c) => c.schema !== CACHE_SCHEMA).map((c) => c.key);
      if (stale.length > 0) await backend.deleteConversations(stale);
      for (const c of held) {
        // Opened during this load: that newer entry wins.
        if (c.schema !== CACHE_SCHEMA || w.recent.has(c.key)) continue;
        w.recent.set(c.key, c.kind === "channel"
          ? { kind: "channel", id: c.id, serverId: c.serverId, openedAt: c.openedAt }
          : { kind: "dm", id: c.id, openedAt: c.openedAt });
      }
      await evict(w);
    } catch (err) {
      console.error("[cache] could not read the cache:", err);
    }
  })();

  return stop;
}

/** Keeps the newest MAX_CACHED_CONVERSATIONS by when they were opened; drops the rest from disk. */
async function evict(w: Writer): Promise<void> {
  if (w.recent.size <= MAX_CACHED_CONVERSATIONS) return;
  const byAge = [...w.recent.entries()].sort((a, b) => b[1].openedAt - a[1].openedAt);
  const dropped = byAge.slice(MAX_CACHED_CONVERSATIONS).map(([key]) => key);
  for (const key of dropped) {
    w.recent.delete(key);
    w.dirty.delete(key);
  }
  await w.backend.deleteConversations(dropped);
}

/** A conversation was opened: it becomes the most recent one, and its messages are cached. */
export function noteConversationOpened(
  conversation: { kind: "channel"; id: string; serverId: string } | { kind: "dm"; id: string }
): void {
  const w = writer;
  if (!w || w.stopped) return;
  const key = conversationKey(w.partition, conversation.kind, conversation.id);
  w.recent.set(key, { ...conversation, openedAt: Date.now() });
  markConversation(w, key);
  void evict(w).catch((err) => console.error("[cache] eviction failed:", err));
}

/** For the tests: write what is pending now instead of after the delay. */
export function flushConversationCache(): Promise<void> {
  return writer ? flush(writer) : Promise.resolve();
}
