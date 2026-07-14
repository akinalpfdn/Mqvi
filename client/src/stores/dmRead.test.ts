/**
 * The read watermark is the one thing that suppresses a push. A client that claims to have read
 * something it never showed the user takes the notification away from the device that could have.
 * These tests exist to make that claim impossible to make by accident.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type ApiResult = { success: boolean; error?: string; data?: unknown };
const markDMRead = vi.fn<(channelId: string, messageId?: string) => Promise<ApiResult>>();
const listDMChannels = vi.fn<() => Promise<ApiResult>>();

vi.mock("../api/dm", () => ({
  markDMRead: (channelId: string, messageId?: string) => markDMRead(channelId, messageId),
  listDMChannels: () => listDMChannels(),
  getDMMessages: vi.fn(async () => ({ success: false })),
  getDMSettings: vi.fn(async () => ({ success: false })),
  hideDM: vi.fn(), pinDMConversation: vi.fn(), unpinDMConversation: vi.fn(),
  muteDM: vi.fn(), unmuteDM: vi.fn(),
}));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("./toastStore", () => ({ useToastStore: { getState: () => ({ addToast: vi.fn() }) } }));
vi.mock("../utils/pushDismiss", () => ({
  dismissNotificationsFor: vi.fn(async () => {}),
  dismissReadNotifications: vi.fn(async () => {}),
}));

let e2eeStatus: "ready" | "error" | "uninitialized" = "ready";
vi.mock("./e2eeStore", () => ({
  useE2EEStore: { getState: () => ({ initStatus: e2eeStatus, localDeviceId: "dev-1" }) },
}));

import { useDMStore } from "./dmStore";
import { resetDMReadTracking } from "./slices/dmSettingsSlice";
import { dismissReadNotifications } from "../utils/pushDismiss";
import type { DMMessage } from "../types";

function msg(id: string, over: Partial<DMMessage> = {}): DMMessage {
  return {
    id,
    dm_channel_id: "c1",
    user_id: "them",
    content: "hello",
    encryption_version: 0,
    created_at: "2026-07-14 10:00:00",
    ...over,
  } as DMMessage;
}

function hold(messages: DMMessage[]) {
  useDMStore.setState({ messagesByChannel: { c1: messages } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resetDMReadTracking();
  markDMRead.mockResolvedValue({ success: true });
  e2eeStatus = "ready";
  useDMStore.setState({
    messagesByChannel: {},
    dmUnreadCounts: {},
    channels: [],
    _unreadFetchGen: 0,
    _unreadFetchActive: false,
    _unreadFetchRaced: false,
    _unreadRefetches: 0,
  });
});

describe("markDMReadUpTo — the claim must be provable", () => {
  it("says nothing when it holds no messages", () => {
    useDMStore.setState({ dmUnreadCounts: { c1: 5 } });

    useDMStore.getState().markDMReadUpTo("c1");

    expect(markDMRead).not.toHaveBeenCalled();
    expect(useDMStore.getState().dmUnreadCounts.c1).toBe(5);
  });

  // The old bug: with nothing loaded the client sent an empty id, which the server reads as
  // "mark the whole conversation read". An E2EE client that cannot decrypt loads nothing, so it
  // silently marked every DM it opened fully read, forever.
  it("says nothing when E2EE never came up, even with messages held", () => {
    e2eeStatus = "error";
    hold([msg("m1")]);

    useDMStore.getState().markDMReadUpTo("c1");

    expect(markDMRead).not.toHaveBeenCalled();
  });

  it("never claims a message that failed to decrypt", () => {
    hold([
      msg("m1", { encryption_version: 1, content: "decrypted" }),
      msg("m2", { encryption_version: 1, content: null }),
    ]);

    useDMStore.getState().markDMReadUpTo("c1");

    // m2 is a placeholder on screen. The watermark stops at the last message the user could read.
    expect(markDMRead).toHaveBeenCalledWith("c1", "m1");
  });

  it("says nothing when nothing in the conversation decrypted", () => {
    hold([msg("m1", { encryption_version: 1, content: null })]);

    useDMStore.getState().markDMReadUpTo("c1");

    expect(markDMRead).not.toHaveBeenCalled();
  });

  it("marks read up to the newest readable message and drops the badge", () => {
    useDMStore.setState({ dmUnreadCounts: { c1: 2 } });
    hold([msg("m1"), msg("m2")]);

    useDMStore.getState().markDMReadUpTo("c1");

    expect(markDMRead).toHaveBeenCalledWith("c1", "m2");
    expect(useDMStore.getState().dmUnreadCounts.c1).toBeUndefined();
  });

  it("does not re-post for a watermark it has already sent", () => {
    hold([msg("m1")]);

    useDMStore.getState().markDMReadUpTo("c1");
    useDMStore.getState().markDMReadUpTo("c1");
    useDMStore.getState().markDMReadUpTo("c1");

    expect(markDMRead).toHaveBeenCalledTimes(1);
  });

  // A failed POST must not poison the dedupe guard. If it did, the server would keep counting
  // the conversation unread and nothing would ever ask it again — a badge that never clears.
  it("retries after a failed POST instead of giving up on the conversation", async () => {
    vi.useFakeTimers();
    markDMRead.mockResolvedValueOnce({ success: false, error: "offline" });
    hold([msg("m1")]);

    useDMStore.getState().markDMReadUpTo("c1");
    expect(markDMRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0); // let the failure land

    useDMStore.getState().markDMReadUpTo("c1"); // same watermark — the guard must not block it
    await vi.advanceTimersByTimeAsync(1000);

    expect(markDMRead).toHaveBeenCalledTimes(2);
    expect(markDMRead).toHaveBeenLastCalledWith("c1", "m1");
    vi.useRealTimers();
  });

  it("coalesces a burst: the first fires at once, the rest collapse into one", async () => {
    vi.useFakeTimers();
    hold([msg("m1")]);
    useDMStore.getState().markDMReadUpTo("c1");
    expect(markDMRead).toHaveBeenCalledWith("c1", "m1"); // leading edge — no waiting

    hold([msg("m1"), msg("m2")]);
    useDMStore.getState().markDMReadUpTo("c1");
    hold([msg("m1"), msg("m2"), msg("m3")]);
    useDMStore.getState().markDMReadUpTo("c1");
    expect(markDMRead).toHaveBeenCalledTimes(1); // still inside the window

    await vi.advanceTimersByTimeAsync(1000);

    expect(markDMRead).toHaveBeenCalledTimes(2);
    expect(markDMRead).toHaveBeenLastCalledWith("c1", "m3"); // one POST, newest watermark
    vi.useRealTimers();
  });
});

describe("markDMReadAll — an explicit claim by the user", () => {
  it("marks the whole conversation read with no message id", () => {
    useDMStore.setState({ dmUnreadCounts: { c1: 9 } });

    useDMStore.getState().markDMReadAll("c1");

    expect(markDMRead).toHaveBeenCalledWith("c1", undefined);
    expect(useDMStore.getState().dmUnreadCounts.c1).toBeUndefined();
  });
});

describe("applyServerUnread — a snapshot that raced is not a truth", () => {
  it("re-fetches instead of guessing when a message lands mid-flight", async () => {
    // The snapshot is a bare count. It cannot say whether it already includes the message that
    // just arrived. Adding it on top double-counts; taking the snapshot verbatim drops the badge.
    listDMChannels
      .mockResolvedValueOnce({ success: true, data: [{ id: "c1", unread_count: 1 }] })
      .mockResolvedValueOnce({ success: true, data: [{ id: "c1", unread_count: 1 }] });

    const fetching = useDMStore.getState().fetchChannels();
    useDMStore.getState().incrementDMUnread("c1"); // races the request
    await fetching;
    await vi.waitFor(() => expect(listDMChannels).toHaveBeenCalledTimes(2));

    // 1, not 2. The second snapshot was taken after the message, so it is simply right.
    expect(useDMStore.getState().dmUnreadCounts.c1).toBe(1);
  });

  it("re-fetches when a read on another device races the snapshot", async () => {
    listDMChannels
      .mockResolvedValueOnce({ success: true, data: [{ id: "c1", unread_count: 3 }] })
      .mockResolvedValueOnce({ success: true, data: [{ id: "c1", unread_count: 0 }] });

    const fetching = useDMStore.getState().fetchChannels();
    useDMStore.getState().handleDMRead({ dm_channel_id: "c1", unread_count: 0 });
    await fetching;
    await vi.waitFor(() => expect(listDMChannels).toHaveBeenCalledTimes(2));

    expect(useDMStore.getState().dmUnreadCounts.c1).toBeUndefined();
  });

  it("ignores a stale snapshot when a newer fetch has superseded it", () => {
    const store = useDMStore.getState();
    const stale = store.beginUnreadFetch();
    const fresh = store.beginUnreadFetch();

    store.applyServerUnread({ c1: 7 }, stale);
    expect(useDMStore.getState().dmUnreadCounts.c1).toBeUndefined();

    store.applyServerUnread({ c1: 2 }, fresh);
    expect(useDMStore.getState().dmUnreadCounts.c1).toBe(2);
  });

  // Rollback: an old server omits unread_count. "It did not say" is not "everything is read".
  it("keeps the badges and the tray when the server does not report unread", async () => {
    useDMStore.setState({ dmUnreadCounts: { c1: 4 } });
    listDMChannels.mockResolvedValueOnce({ success: true, data: [{ id: "c1" }] });

    await useDMStore.getState().fetchChannels();

    expect(useDMStore.getState().dmUnreadCounts.c1).toBe(4);
    expect(dismissReadNotifications).not.toHaveBeenCalled();
  });

  it("keeps the badges and the tray when the request fails outright", async () => {
    useDMStore.setState({ dmUnreadCounts: { c1: 4 } });
    listDMChannels.mockResolvedValueOnce({ success: false });

    await useDMStore.getState().fetchChannels();

    expect(useDMStore.getState().dmUnreadCounts.c1).toBe(4);
    expect(dismissReadNotifications).not.toHaveBeenCalled();
  });

  it("stops re-fetching rather than looping when events keep racing", async () => {
    listDMChannels.mockImplementation(async () => {
      // Every snapshot is raced by a fresh arrival before it can be applied.
      queueMicrotask(() => useDMStore.getState().incrementDMUnread("c1"));
      return { success: true, data: [{ id: "c1", unread_count: 1 }] };
    });

    await useDMStore.getState().fetchChannels();
    await vi.waitFor(() =>
      expect(useDMStore.getState()._unreadFetchActive).toBe(false)
    );

    expect(listDMChannels.mock.calls.length).toBeLessThanOrEqual(4); // 1 + MAX_UNREAD_REFETCHES
  });
});
