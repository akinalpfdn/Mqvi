/**
 * Loading is per conversation: one conversation fetching must not blank another that already holds
 * messages, and an older-page fetch runs once however many scroll events ask for it. A reconnect
 * re-reads the whole held window (up to the server's page cap) so a delete anywhere in it is seen.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DMMessage, Message } from "../types";

const messageApi = vi.hoisted(() => ({ getMessages: vi.fn() }));
vi.mock("../api/messages", () => messageApi);
const dmApi = vi.hoisted(() => ({ getDMMessages: vi.fn(), listDMChannels: vi.fn(async () => ({ success: false })) }));
vi.mock("../api/dm", () => dmApi);
vi.mock("../api/readState", () => ({ markRead: vi.fn(async () => ({ success: true })) }));
vi.mock("../crypto/channelEncryption", () => ({ decryptChannelMessages: vi.fn(async (m: unknown[]) => m) }));
vi.mock("../crypto/dmEncryption", () => ({ decryptDMMessages: vi.fn(async (m: unknown[]) => m) }));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));

const { useMessageStore } = await import("./messageStore");
const { useDMStore } = await import("./dmStore");
const { useServerStore } = await import("./serverStore");
const { useE2EEStore } = await import("./e2eeStore");

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const at = (i: number) => new Date(Date.UTC(2026, 9, 21, 10, 0, i)).toISOString();
const chMsg = (id: string, i: number) => ({ id, channel_id: "c1", created_at: at(i) }) as Message;
const dmMsg = (id: string, i: number) => ({ id, dm_channel_id: "d1", created_at: at(i) }) as DMMessage;
const page = <T,>(messages: T[], has_more = false) => ({ success: true, data: { messages, has_more } });

beforeEach(() => {
  vi.clearAllMocks();
  useServerStore.setState({ activeServerId: "s1" });
  useE2EEStore.setState({ initStatus: "ready" });
  useMessageStore.getState().invalidateFetchCache();
  useMessageStore.setState({ loadingByChannel: {}, loadingMoreByChannel: {} });
  useDMStore.setState({ messagesByChannel: {}, hasMoreByChannel: {}, loadingByChannel: {}, loadingMoreByChannel: {} });
});

describe("per-conversation loading", () => {
  it("should mark only the conversation being fetched as loading", async () => {
    const pending = deferred<unknown>();
    messageApi.getMessages.mockReturnValue(pending.promise);

    const fetching = useMessageStore.getState().fetchMessages("b", "s1");

    expect(useMessageStore.getState().loadingByChannel).toEqual({ b: true });
    pending.resolve(page([]));
    await fetching;
    expect(useMessageStore.getState().loadingByChannel).toEqual({});
  });

  it("should clear a DM's loading flag when its fetch fails", async () => {
    dmApi.getDMMessages.mockResolvedValue({ success: false });

    await useDMStore.getState().fetchMessages("d1");

    expect(useDMStore.getState().loadingByChannel).toEqual({});
  });

  it("should fetch a DM's first page once when two views ask at the same time", async () => {
    dmApi.getDMMessages.mockResolvedValue(page([dmMsg("m1", 1)]));

    await Promise.all([useDMStore.getState().fetchMessages("d1"), useDMStore.getState().fetchMessages("d1")]);

    expect(dmApi.getDMMessages).toHaveBeenCalledTimes(1);
  });
});

describe("older pages", () => {
  it("should fetch a DM's older page once however many scroll events ask", async () => {
    useDMStore.setState({ messagesByChannel: { d1: [dmMsg("m10", 10)] }, hasMoreByChannel: { d1: true } });
    const older = deferred<unknown>();
    dmApi.getDMMessages.mockReturnValue(older.promise);

    const calls = [1, 2, 3].map(() => useDMStore.getState().fetchOlderMessages("d1"));
    older.resolve(page([dmMsg("m1", 1)]));
    await Promise.all(calls);

    expect(dmApi.getDMMessages).toHaveBeenCalledTimes(1);
    expect(useDMStore.getState().messagesByChannel["d1"].map((m) => m.id)).toEqual(["m1", "m10"]);
    expect(useDMStore.getState().loadingMoreByChannel).toEqual({});
  });

  it("should not let one channel's older page block another's", async () => {
    useMessageStore.setState({
      messagesByChannel: { a: [chMsg("a1", 5)], b: [chMsg("b1", 5)] },
      hasMoreByChannel: { a: true, b: true },
    });
    messageApi.getMessages.mockReturnValue(new Promise(() => {}));

    void useMessageStore.getState().fetchOlderMessages("a", "s1");
    void useMessageStore.getState().fetchOlderMessages("b", "s1");

    expect(messageApi.getMessages).toHaveBeenCalledTimes(2);
  });
});

describe("older page against a changed conversation", () => {
  it("should drop a channel's older page when the keys changed while it loaded", async () => {
    useMessageStore.setState({ messagesByChannel: { c1: [chMsg("m10", 10)] }, hasMoreByChannel: { c1: true } });
    const older = deferred<unknown>();
    messageApi.getMessages.mockReturnValue(older.promise);

    const loading = useMessageStore.getState().fetchOlderMessages("c1", "s1");
    useMessageStore.getState().invalidateFetchCache();
    older.resolve(page([chMsg("m1", 1)], true));

    await expect(loading).resolves.toBeUndefined();
    expect(useMessageStore.getState().messagesByChannel["c1"]).toBeUndefined();
  });

  it("should not prepend a DM's older page onto a list refetched meanwhile", async () => {
    useDMStore.setState({ messagesByChannel: { d1: [dmMsg("m10", 10)] }, hasMoreByChannel: { d1: true } });
    const older = deferred<unknown>();
    dmApi.getDMMessages.mockReturnValue(older.promise);

    const loading = useDMStore.getState().fetchOlderMessages("d1");
    useDMStore.setState({ messagesByChannel: { d1: [dmMsg("m50", 50)] } });
    older.resolve(page([dmMsg("m1", 1)], true));
    await loading;

    // m1..m9 would sit right above m50 with m10..m49 silently missing.
    expect(useDMStore.getState().messagesByChannel["d1"].map((m) => m.id)).toEqual(["m50"]);
    expect(useDMStore.getState().loadingMoreByChannel).toEqual({});
  });
});

describe("resync window", () => {
  it.each([
    [0, 50], [10, 50], [80, 80], [100, 100], [300, 100],
  ])("should ask for %i held messages as a page of %i", async (held, want) => {
    useDMStore.setState({ messagesByChannel: { d1: Array.from({ length: held }, (_, i) => dmMsg(`m${i}`, i)) } });
    dmApi.getDMMessages.mockResolvedValue({ success: false });

    await useDMStore.getState().resyncChannel("d1");

    expect(dmApi.getDMMessages).toHaveBeenCalledWith("d1", undefined, want);
  });

  it("should drop a message deleted deep in the held window while the socket was down", async () => {
    // 80 held: the old 50-message page would not have reached m10.
    const held = Array.from({ length: 80 }, (_, i) => chMsg(`m${i}`, i));
    useMessageStore.setState({ messagesByChannel: { c1: held }, hasMoreByChannel: { c1: false } });
    messageApi.getMessages.mockResolvedValue(page(held.filter((m) => m.id !== "m10")));

    await useMessageStore.getState().resyncChannel("c1", "s1");

    expect(messageApi.getMessages).toHaveBeenCalledWith("s1", "c1", undefined, 80);
    expect(useMessageStore.getState().messagesByChannel["c1"].some((m) => m.id === "m10")).toBe(false);
  });
});
