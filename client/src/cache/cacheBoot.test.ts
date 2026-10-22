/**
 * Cold start from the device cache, on the real IndexedDB backend (fake-indexeddb): the app opens on
 * the cached shell, conversations, tabs and unsent messages before any network answer; an offline
 * start stays in the app; a refused session ends on login with the cache gone.
 */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CachedShell, CachedConversation, CachedPending } from "./cacheBackend";
import type { CategoryWithChannels, DMChannelWithUser, Message, User } from "../types";
import type { Tab } from "../stores/uiStore";

vi.mock("../utils/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/constants")>()),
  isNativeApp: () => true,
  SERVER_URL: "https://chat.example",
}));
vi.mock("../i18n", () => ({
  default: { language: "en", t: (k: string) => k },
  changeLanguage: vi.fn(),
  resolveLanguage: () => "en",
  SUPPORTED_LANGUAGES: { en: true, tr: true },
}));
const authApi = vi.hoisted(() => ({ getMe: vi.fn() }));
vi.mock("../api/auth", () => authApi);
const messageApi = vi.hoisted(() => ({ getMessages: vi.fn() }));
vi.mock("../api/messages", () => messageApi);
vi.mock("../api/readState", () => ({ markRead: vi.fn(async () => ({ success: true })) }));
vi.mock("../crypto/channelEncryption", () => ({ decryptChannelMessages: vi.fn(async (m: unknown[]) => m) }));

const { restoreFromCache } = await import("./cacheBoot");
const { indexedDBBackend: backend, CACHE_SCHEMA } = await import("./cacheBackend");
const { rememberCachedUser, partitionFor } = await import("./cacheSession");
const { useAuthStore } = await import("../stores/authStore");
const { useMessageStore } = await import("../stores/messageStore");
const { useOutboxStore, resetOutbox } = await import("../stores/outboxStore");
const { useUIStore } = await import("../stores/uiStore");
const { useServerStore } = await import("../stores/serverStore");
const { usePreferencesStore } = await import("../stores/preferencesStore");

const yes = () => true;
const alice = { id: "alice", username: "alice" } as User;
const partition = "https://chat.example|alice";
const at = (i: number) => new Date(Date.UTC(2026, 9, 21, 10, 0, i)).toISOString();
const msg = (id: string, i: number) => ({ id, channel_id: "c1", content: id, created_at: at(i) }) as Message;

const tab = (id: string, type: Tab["type"], channelId: string, serverId?: string): Tab => ({
  id, type, channelId, label: channelId, ...(serverId ? { serverInfo: { serverId, serverName: "S", serverIconUrl: null } } : {}),
});

function shell(): CachedShell {
  return {
    partition, schema: CACHE_SCHEMA, user: alice,
    servers: [{ id: "s1" }] as never,
    categoriesByServer: { s1: [{ channels: [{ id: "c1" }] }] as unknown as CategoryWithChannels[] },
    dmChannels: [{ id: "d1" }] as DMChannelWithUser[],
    unreadCounts: { c1: 2 }, channelServerMap: { c1: "s1" }, dmUnreadCounts: {},
    ui: {
      panels: {
        "panel-7": {
          id: "panel-7",
          // c9 is no longer visible; the voice tab never comes back.
          tabs: [tab("tab-1", "text", "c1", "s1"), tab("tab-2", "text", "c9", "s1"), tab("tab-3", "voice", "v1", "s1")],
          activeTabId: "tab-1",
        },
      },
      layout: { type: "leaf", panelId: "panel-7" },
      activePanelId: "panel-7",
    },
  };
}

const conversation: CachedConversation = {
  key: `${partition}|channel:c1`, partition, kind: "channel", id: "c1", serverId: "s1",
  messages: [msg("m1", 1), msg("m2", 2), msg("m3", 3)], hasMore: false, openedAt: 1, schema: CACHE_SCHEMA,
};
const unsent: CachedPending = {
  key: `${partition}|n1`, partition, schema: CACHE_SCHEMA, nonce: "n1", kind: "channel", conversationId: "c1",
  serverId: "s1", content: "queued", replyToId: null, referencedMessage: null, createdAt: at(9), files: [], filesLost: false,
};

async function seed() {
  await backend.putShell(shell(), yes);
  await backend.putConversation(conversation, yes);
  await backend.putPending(unsent, yes);
  rememberCachedUser("alice");
  localStorage.setItem("access_token", "a");
  localStorage.setItem("refresh_token", "r");
}

beforeEach(async () => {
  vi.clearAllMocks();
  await backend.clear(null);
  localStorage.clear();
  resetOutbox();
  useMessageStore.getState().invalidateFetchCache();
  useAuthStore.setState({ user: null, isInitialized: false, isServerUnreachable: false, isSessionConfirmed: true });
  useServerStore.setState({ servers: [], activeServerId: "s1" });
  usePreferencesStore.setState({ fetchAndApply: vi.fn(async () => {}) } as never);
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});

describe("cold start from the cache", () => {
  it("should open on the cached user, conversation, tabs and unsent messages", async () => {
    await seed();

    expect(await restoreFromCache()).toBe(true);

    expect(useAuthStore.getState()).toMatchObject({ user: alice, isInitialized: true, isSessionConfirmed: false });
    expect(useMessageStore.getState().messagesByChannel["c1"].map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(useServerStore.getState().servers.map((s) => s.id)).toEqual(["s1"]);
    const panels = Object.values(useUIStore.getState().panels);
    expect(panels.flatMap((p) => p.tabs.map((t) => t.channelId))).toEqual(["c1"]);
    expect(panels[0].id).not.toBe("panel-7"); // fresh ids, so the next panel opened cannot collide
    expect(useOutboxStore.getState().pendingByConversation["c1"]).toMatchObject([
      { nonce: "n1", status: "failed", failure: "transient" },
    ]);
  });

  it("should not bring back an unsent message whose stored copy the cache already holds", async () => {
    await seed();
    // The app closed between the confirmation landing and the outbox record being deleted.
    await backend.putConversation({ ...conversation, messages: [...conversation.messages, { ...msg("m4", 4), client_nonce: "n1" }] }, yes);

    await restoreFromCache();

    expect(useOutboxStore.getState().find("n1")).toBeUndefined();
    expect(await backend.listPending(partition)).toEqual([]);
  });

  it("should start normally without a stored session", async () => {
    await seed();
    localStorage.removeItem("access_token");

    expect(await restoreFromCache()).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("should not open a cache written for another backend", async () => {
    await seed();
    localStorage.setItem("mqvi_cache_user", JSON.stringify({ server: "https://other.example", userId: "alice" }));

    expect(await restoreFromCache()).toBe(false);
  });

  it("should resync a cached conversation on first open instead of loading a page on top", async () => {
    await seed();
    await restoreFromCache();
    // m2 was deleted while the app was closed.
    messageApi.getMessages.mockResolvedValue({ success: true, data: { messages: [msg("m1", 1), msg("m3", 3)], has_more: false } });

    await useMessageStore.getState().fetchMessages("c1", "s1");

    expect(messageApi.getMessages).toHaveBeenCalledWith("s1", "c1", undefined, 50);
    expect(useMessageStore.getState().messagesByChannel["c1"].map((m) => m.id)).toEqual(["m1", "m3"]);
  });
});

describe("confirming the cached session", () => {
  beforeEach(async () => {
    await seed();
    await restoreFromCache();
  });

  it("should confirm and refresh the user when /users/me answers", async () => {
    authApi.getMe.mockResolvedValue({ success: true, data: { ...alice, display_name: "Alice" }, httpStatus: 200 });

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState()).toMatchObject({ isSessionConfirmed: true, user: { display_name: "Alice" } });
  });

  it("should stay in the app, not on the connecting screen, when the server cannot be reached", async () => {
    authApi.getMe.mockResolvedValue({ success: false, httpStatus: 0 });

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState()).toMatchObject({ user: alice, isServerUnreachable: false, isSessionConfirmed: false });
  });

  it("should land on login with nothing cached when the server refuses the session", async () => {
    authApi.getMe.mockResolvedValue({ success: false, httpStatus: 403, error: "forbidden" });

    await useAuthStore.getState().initialize();
    await new Promise((r) => setTimeout(r, 0)); // the wipe is not awaited by initialize

    expect(useAuthStore.getState().user).toBeNull();
    expect(await backend.getShell(partitionFor("alice"))).toBeUndefined();
    expect(await backend.listConversations(partitionFor("alice"))).toEqual([]);
    expect(await backend.listPending(partitionFor("alice"))).toEqual([]);
  });
});
