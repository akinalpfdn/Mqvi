/**
 * The channel mark-read shares the server's read rate limit with the DM one. Undebounced, a busy
 * channel POSTs once per incoming message, trips the limit, and the 429 lands on the DM watermark
 * too — so the phone starts buzzing for the conversation the user is reading on the desktop.
 * That is the bug FIX-04 exists to prevent, reintroduced through a rate limiter.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const markRead = vi.fn<(s: string, c: string, m: string) => Promise<{ success: boolean }>>();
vi.mock("../api/readState", () => ({
  markRead: (s: string, c: string, m: string) => markRead(s, c, m),
  getUnreadCounts: vi.fn(async () => ({ success: false })),
  markAllRead: vi.fn(async () => ({ success: false })),
  markMentionSeen: vi.fn(async () => ({ success: false })),
}));
vi.mock("./serverStore", () => ({
  useServerStore: { getState: () => ({ activeServerId: "srv-1", isServerMuted: () => false }) },
}));
vi.mock("./channelStore", () => ({
  useChannelStore: { getState: () => ({ mutedChannelIds: new Set<string>() }) },
}));

import { useReadStateStore } from "./readStateStore";
import { resetMarkReadTracking } from "./shared/markReadTracking";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  resetMarkReadTracking();
  markRead.mockResolvedValue({ success: true });
  useReadStateStore.setState({
    unreadCounts: {},
    channelServerMap: { "chan-1": "srv-1" },
    lastMentionSeen: {},
  });
});

describe("markAsRead — a busy channel must not spend the rate limit", () => {
  it("coalesces a burst into two POSTs, not one per message", async () => {
    vi.useFakeTimers();

    // 40 messages land in a busy channel while the user watches it. Undebounced this was 40
    // POSTs, which trips a 30-per-10s limit and puts the user in cooldown.
    for (let i = 1; i <= 40; i++) {
      useReadStateStore.getState().markAsRead("chan-1", `m${i}`);
    }
    expect(markRead).toHaveBeenCalledTimes(1); // leading edge only
    expect(markRead).toHaveBeenCalledWith("srv-1", "chan-1", "m1");

    await vi.advanceTimersByTimeAsync(1000);

    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead).toHaveBeenLastCalledWith("srv-1", "chan-1", "m40"); // newest watermark
    vi.useRealTimers();
  });

  it("does not re-post a watermark it has already sent", () => {
    useReadStateStore.getState().markAsRead("chan-1", "m1");
    useReadStateStore.getState().markAsRead("chan-1", "m1");
    useReadStateStore.getState().markAsRead("chan-1", "m1");

    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it("clears the badge immediately, before the POST resolves", () => {
    useReadStateStore.setState({ unreadCounts: { "chan-1": 7 } });

    useReadStateStore.getState().markAsRead("chan-1", "m1");

    expect(useReadStateStore.getState().unreadCounts["chan-1"]).toBeUndefined();
  });

  // A failed POST must not poison the dedupe guard, or the server keeps counting the channel
  // unread and nothing ever asks it again.
  it("retries after a failed POST", async () => {
    vi.useFakeTimers();
    markRead.mockResolvedValueOnce({ success: false });

    useReadStateStore.getState().markAsRead("chan-1", "m1");
    expect(markRead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);

    useReadStateStore.getState().markAsRead("chan-1", "m1");
    await vi.advanceTimersByTimeAsync(1000);

    expect(markRead).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
