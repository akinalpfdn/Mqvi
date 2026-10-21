/**
 * The IndexedDB backend itself, on fake-indexeddb: the partition index, the partition-keeping clear,
 * an unsent message's record surviving the round trip, and the stillCurrent gate. The cache's rules
 * are tested in conversationCache.test.ts; this is the part that touches the database.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { CacheBackend, CachedConversation, CachedPending, CachedShell } from "./cacheBackend";
import type { User } from "../types";

let backend: CacheBackend;

beforeEach(async () => {
  // A new database per test, and a fresh module so its cached connection does not carry over.
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  ({ indexedDBBackend: backend } = await import("./cacheBackend"));
});

const yes = () => true;

const conversation = (partition: string, id: string): CachedConversation => ({
  key: `${partition}|dm:${id}`, partition, kind: "dm", id, messages: [], hasMore: false, openedAt: 1, schema: 1,
});
const shell = (partition: string): CachedShell => ({
  partition, schema: 1, user: { id: "u" } as User, servers: [], categoriesByServer: {}, dmChannels: [],
  unreadCounts: {}, dmUnreadCounts: {},
});
const pending = (partition: string, nonce: string, files: File[] = []): CachedPending => ({
  key: `${partition}|${nonce}`, partition, schema: 1, nonce, kind: "dm", conversationId: "d1", content: "hi",
  replyToId: null, referencedMessage: null, createdAt: "2026-10-21T10:00:00Z", files, filesLost: false,
});

describe("indexedDBBackend", () => {
  it("should list only the asked partition's conversations", async () => {
    await backend.putConversation(conversation("A", "d1"), yes);
    await backend.putConversation(conversation("B", "d2"), yes);

    expect((await backend.listConversations("A")).map((c) => c.id)).toEqual(["d1"]);
  });

  it("should keep only the given partition across every store", async () => {
    for (const p of ["A", "B"]) {
      await backend.putConversation(conversation(p, "d1"), yes);
      await backend.putShell(shell(p), yes);
      await backend.putPending(pending(p, "n1"), yes);
    }

    await backend.clear("A");

    expect(await backend.listConversations("B")).toEqual([]);
    expect(await backend.getShell("B")).toBeUndefined();
    expect(await backend.listPending("B")).toEqual([]);
    expect(await backend.listConversations("A")).toHaveLength(1);
    expect(await backend.getShell("A")).toBeDefined();
    expect(await backend.listPending("A")).toHaveLength(1);
  });

  it("should leave nothing after a full clear", async () => {
    await backend.putConversation(conversation("A", "d1"), yes);
    await backend.putShell(shell("A"), yes);
    await backend.putPending(pending("A", "n1"), yes);

    await backend.clear(null);

    expect(await backend.listConversations("A")).toEqual([]);
    expect(await backend.getShell("A")).toBeUndefined();
    expect(await backend.listPending("A")).toEqual([]);
  });

  // The file itself is not round-tripped here: Node's structuredClone, which fake-indexeddb uses,
  // turns a File into an empty object, where a browser's keeps it. That part is checked on device.
  it("should give back an unsent message's fields intact", async () => {
    const record = { ...pending("A", "n1"), replyToId: "m0", referencedMessage: { id: "m0", author: null, content: "q" } };

    await backend.putPending(record, yes);

    expect(await backend.listPending("A")).toEqual([record]);
  });

  it("should write nothing once its session is no longer current", async () => {
    await backend.putConversation(conversation("A", "d1"), () => false);
    await backend.putShell(shell("A"), () => false);
    await backend.putPending(pending("A", "n1"), () => false);

    expect(await backend.listConversations("A")).toEqual([]);
    expect(await backend.getShell("A")).toBeUndefined();
    expect(await backend.listPending("A")).toEqual([]);
  });

  it("should delete the given conversations and unsent messages", async () => {
    await backend.putConversation(conversation("A", "d1"), yes);
    await backend.putConversation(conversation("A", "d2"), yes);
    await backend.putPending(pending("A", "n1"), yes);

    await backend.deleteConversations(["A|dm:d1"]);
    await backend.deletePending("A|n1");

    expect((await backend.listConversations("A")).map((c) => c.id)).toEqual(["d2"]);
    expect(await backend.listPending("A")).toEqual([]);
  });
});
