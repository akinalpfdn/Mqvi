/**
 * The on-device cache keeps at most 20 conversations of 100 messages, follows every change the
 * stores make to them, belongs to one backend + account, and is gone after sign-out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CacheBackend, CachedConversation, CachedPending, CachedShell } from "./cacheBackend";
import type { DMMessage, Message, User } from "../types";

const platform = vi.hoisted(() => ({ native: true }));
vi.mock("../utils/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/constants")>()),
  isNativeApp: () => platform.native,
  SERVER_URL: "https://chat.example",
}));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));

const { startConversationCache, noteConversationOpened, flushConversationCache, MAX_CACHED_MESSAGES } =
  await import("./conversationCache");
const { wipeConversationCache, retryPendingWipe } = await import("./cacheSession");
const { useMessageStore } = await import("../stores/messageStore");
const { useDMStore } = await import("../stores/dmStore");
const { useAuthStore } = await import("../stores/authStore");
const { useOutboxStore, resetOutbox } = await import("../stores/outboxStore");

/** IndexedDB stand-in with the same contract, including the stillCurrent check before writing. */
function memoryBackend() {
  const conversations = new Map<string, CachedConversation>();
  const shells = new Map<string, CachedShell>();
  const outbox = new Map<string, CachedPending>();
  const backend: CacheBackend & { failClear: boolean; failFiles: boolean; putDelay: number } = {
    failClear: false,
    failFiles: false,
    putDelay: 0,
    async listPending(partition) {
      return [...outbox.values()].filter((p) => p.partition === partition);
    },
    async putPending(p, stillCurrent) {
      await new Promise((r) => setTimeout(r, backend.putDelay));
      if (backend.failFiles && p.files.length > 0) throw new DOMException("full", "QuotaExceededError");
      if (stillCurrent()) outbox.set(p.key, p);
    },
    async deletePending(key) { outbox.delete(key); },
    async listConversations(partition) {
      return [...conversations.values()].filter((c) => c.partition === partition);
    },
    async putConversation(c, stillCurrent) {
      await Promise.resolve();
      if (stillCurrent()) conversations.set(c.key, structuredClone(c));
    },
    async deleteConversations(keys) { keys.forEach((k) => conversations.delete(k)); },
    async getShell(partition) { return shells.get(partition); },
    async putShell(s, stillCurrent) {
      await Promise.resolve();
      if (stillCurrent()) shells.set(s.partition, structuredClone(s));
    },
    async clear(keep) {
      if (backend.failClear) throw new Error("disk");
      for (const [k, c] of conversations) if (c.partition !== keep) conversations.delete(k);
      for (const [k, s] of shells) if (s.partition !== keep) shells.delete(k);
      for (const [k, p] of outbox) if (p.partition !== keep) outbox.delete(k);
    },
  };
  return { backend, conversations, shells, outbox };
}

const msg = (id: string, i: number, content = id) =>
  ({ id, channel_id: "c1", content, created_at: new Date(Date.UTC(2026, 9, 21, 10, 0, i)).toISOString() }) as Message;
const settle = () => new Promise((r) => setTimeout(r, 0));

let store: ReturnType<typeof memoryBackend>;
let stop: () => void = () => {};

beforeEach(async () => {
  resetOutbox();
  platform.native = true;
  localStorage.clear();
  store = memoryBackend();
  useAuthStore.setState({ user: { id: "alice" } as User });
  useMessageStore.setState({ messagesByChannel: {}, hasMoreByChannel: {} });
  useDMStore.setState({ messagesByChannel: {}, hasMoreByChannel: {} });
  stop = startConversationCache("alice", store.backend);
  await settle();
});

afterEach(() => stop());

const keyOf = (kind: string, id: string, user = "alice") => `https://chat.example|${user}|${kind}:${id}`;

describe("what is cached", () => {
  it("should cache an opened conversation's messages, newest 100, and say there is more", async () => {
    const many = Array.from({ length: 130 }, (_, i) => msg(`m${i}`, i));
    useMessageStore.setState({ messagesByChannel: { c1: many }, hasMoreByChannel: { c1: false } });

    noteConversationOpened({ kind: "channel", id: "c1", serverId: "s1" });
    await flushConversationCache();

    const cached = store.conversations.get(keyOf("channel", "c1"))!;
    expect(cached.messages).toHaveLength(MAX_CACHED_MESSAGES);
    expect(cached.messages[0].id).toBe("m30");
    expect(cached.hasMore).toBe(true);
  });

  it("should not cache a conversation that was never opened", async () => {
    useMessageStore.setState({ messagesByChannel: { other: [msg("x", 1)] } });

    await flushConversationCache();

    expect([...store.conversations.keys()]).toEqual([]);
  });

  it("should keep only the 20 most recently opened conversations", async () => {
    for (let i = 0; i < 21; i++) {
      useDMStore.setState((s) => ({ messagesByChannel: { ...s.messagesByChannel, [`d${i}`]: [] as DMMessage[] } }));
      vi.spyOn(Date, "now").mockReturnValue(1_000 + i);
      noteConversationOpened({ kind: "dm", id: `d${i}` });
    }
    vi.restoreAllMocks();
    await flushConversationCache();
    await settle();

    expect(store.conversations.size).toBe(20);
    expect(store.conversations.has(keyOf("dm", "d0"))).toBe(false);
    expect(store.conversations.has(keyOf("dm", "d20"))).toBe(true);
  });
});

describe("following the stores", () => {
  beforeEach(async () => {
    useMessageStore.setState({ messagesByChannel: { c1: [msg("m1", 1), msg("m2", 2)] } });
    noteConversationOpened({ kind: "channel", id: "c1", serverId: "s1" });
    await flushConversationCache();
  });

  it("should drop a message deleted while online", async () => {
    useMessageStore.getState().handleMessageDelete({ id: "m1", channel_id: "c1" });
    await flushConversationCache();

    expect(store.conversations.get(keyOf("channel", "c1"))!.messages.map((m) => m.id)).toEqual(["m2"]);
  });

  it("should take an edit", async () => {
    useMessageStore.getState().handleMessageUpdate({ ...msg("m2", 2), content: "edited" });
    await flushConversationCache();

    expect(store.conversations.get(keyOf("channel", "c1"))!.messages[1].content).toBe("edited");
  });

  it("should take a new message", async () => {
    useMessageStore.getState().handleMessageCreate(msg("m3", 3));
    await flushConversationCache();

    expect(store.conversations.get(keyOf("channel", "c1"))!.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("partitions and sign-out", () => {
  it("should drop another account's records when a different user starts", async () => {
    useMessageStore.setState({ messagesByChannel: { c1: [msg("m1", 1)] } });
    noteConversationOpened({ kind: "channel", id: "c1", serverId: "s1" });
    await flushConversationCache();
    stop();

    useAuthStore.setState({ user: { id: "bob" } as User });
    stop = startConversationCache("bob", store.backend);
    await settle();

    expect([...store.conversations.keys()].some((k) => k.includes("|alice|"))).toBe(false);
    expect([...store.shells.keys()].some((k) => k.includes("|alice"))).toBe(false);
  });

  it("should leave nothing after sign-out, not even a write that was already queued", async () => {
    useMessageStore.setState({ messagesByChannel: { c1: [msg("m1", 1)] } });
    noteConversationOpened({ kind: "channel", id: "c1", serverId: "s1" });
    await flushConversationCache();
    useMessageStore.getState().handleMessageCreate(msg("m2", 2)); // queued, not yet written

    const flushing = flushConversationCache(); // already past its first check
    await wipeConversationCache(store.backend);
    await flushing;
    await new Promise((r) => setTimeout(r, 500)); // past the write delay

    expect(store.conversations.size).toBe(0);
    expect(store.shells.size).toBe(0);
  });

  it("should finish at the next launch a wipe that failed", async () => {
    useMessageStore.setState({ messagesByChannel: { c1: [msg("m1", 1)] } });
    noteConversationOpened({ kind: "channel", id: "c1", serverId: "s1" });
    await flushConversationCache();

    store.backend.failClear = true;
    await wipeConversationCache(store.backend);
    expect(store.conversations.size).toBe(1);

    store.backend.failClear = false;
    await retryPendingWipe(store.backend);
    expect(store.conversations.size).toBe(0);
  });
});

describe("unsent messages", () => {
  const pending = (nonce: string, files: File[] = []) => ({
    nonce, kind: "dm" as const, conversationId: "d1", content: "hi", files, attachments: [],
    replyToId: null, referencedMessage: null, createdAt: "2026-10-21T10:00:00Z",
    status: "sending" as const, failure: null,
  });
  const file = new File(["x"], "a.png", { type: "image/png" });
  // The writes chain behind each other and the stand-in yields a timer turn per put.
  const writes = () => new Promise((r) => setTimeout(r, 10));

  it("should keep a queued message with its files until it is confirmed", async () => {
    useOutboxStore.getState().add(pending("n1", [file]));
    await writes();
    expect(store.outbox.get("https://chat.example|alice|n1")).toMatchObject({ files: [file], filesLost: false });

    useOutboxStore.getState().remove("n1");
    await writes();
    expect(store.outbox.size).toBe(0);
  });

  it("should keep the text and say the files are gone when they cannot be stored", async () => {
    store.backend.failFiles = true;

    useOutboxStore.getState().add(pending("n1", [file]));
    await writes();

    expect(store.outbox.get("https://chat.example|alice|n1")).toMatchObject({ content: "hi", files: [], filesLost: true });
  });

  it("should not leave a message confirmed before its own write finished", async () => {
    store.backend.putDelay = 20;

    useOutboxStore.getState().add(pending("n1"));
    useOutboxStore.getState().remove("n1");
    await new Promise((r) => setTimeout(r, 50));

    expect(store.outbox.size).toBe(0);
  });

  it("should drop unsent messages with everything else at sign-out", async () => {
    useOutboxStore.getState().add(pending("n1"));
    await writes();

    await wipeConversationCache(store.backend);

    expect(store.outbox.size).toBe(0);
  });
});

describe("browser", () => {
  it("should write nothing in a web browser", async () => {
    stop();
    platform.native = false;
    stop = startConversationCache("alice", store.backend);
    useMessageStore.setState({ messagesByChannel: { c1: [msg("m1", 1)] } });
    noteConversationOpened({ kind: "channel", id: "c1", serverId: "s1" });
    await flushConversationCache();
    await new Promise((r) => setTimeout(r, 500));

    expect(store.conversations.size).toBe(0);
    expect(store.shells.size).toBe(0);
  });
});
