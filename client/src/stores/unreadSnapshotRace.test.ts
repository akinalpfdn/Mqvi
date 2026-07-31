/**
 * The unread snapshot is a bare per-channel count. It cannot say whether it was taken before or
 * after an event that arrived while it was in flight, and the old code took it verbatim — so a
 * message that landed mid-request had its badge deleted by the response that predated it.
 *
 * Guessing is not an option either: adding on top double-counts. These tests pin the rule the DM
 * list already followed — a raced snapshot is discarded and retaken, bounded so a busy channel
 * cannot spin forever.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type UnreadInfo = { channel_id: string; unread_count: number };
const getUnreadCounts = vi.fn<
  (serverId: string) => Promise<{ success: boolean; data?: UnreadInfo[] }>
>();

vi.mock("../api/readState", () => ({
  getUnreadCounts: (serverId: string) => getUnreadCounts(serverId),
  markRead: vi.fn(async () => ({ success: true })),
  markAllRead: vi.fn(async () => ({ success: true })),
  markMentionSeen: vi.fn(async () => ({ success: true })),
}));
vi.mock("./serverStore", () => ({
  useServerStore: {
    getState: () => ({
      activeServerId: "srv-1",
      mutedServerIds: new Set<string>(),
      servers: [{ id: "srv-1" }],
    }),
  },
}));
vi.mock("./channelStore", () => ({
  useChannelStore: { getState: () => ({ mutedChannelIds: new Set<string>() }) },
}));

import { useReadStateStore } from "./readStateStore";
import { resetMarkReadTracking } from "./shared/markReadTracking";

const SERVER = "srv-1";
const CHANNEL = "chan-1";

beforeEach(() => {
  // mockReset, not clearAllMocks: the latter keeps queued mockResolvedValueOnce values, so a test
  // that consumes fewer than it queued leaks the rest into the next one — which turns a single
  // real failure into a cascade and makes it impossible to tell which test proves what.
  getUnreadCounts.mockReset();
  resetMarkReadTracking();
  useReadStateStore.setState({
    unreadCounts: {},
    channelServerMap: { [CHANNEL]: SERVER },
    lastMentionSeen: {},
    _unreadFetch: {},
  });
});

describe("fetchUnreadCounts", () => {
  it("should re-fetch instead of guessing when a message lands mid-flight", async () => {
    getUnreadCounts
      .mockResolvedValueOnce({ success: true, data: [{ channel_id: CHANNEL, unread_count: 1 }] })
      .mockResolvedValueOnce({ success: true, data: [{ channel_id: CHANNEL, unread_count: 2 }] });

    const fetching = useReadStateStore.getState().fetchUnreadCounts(SERVER);
    // The WS delivers a message while the request is out.
    useReadStateStore.getState().incrementUnread(CHANNEL);
    await fetching;
    await vi.waitFor(() => expect(getUnreadCounts).toHaveBeenCalledTimes(2));

    // 2, from the snapshot taken after the message — not 1, which is what the raced response said.
    expect(useReadStateStore.getState().unreadCounts[CHANNEL]).toBe(2);
  });

  it("should not resurrect a channel that was read on another device", async () => {
    useReadStateStore.setState({ unreadCounts: { [CHANNEL]: 4 } });
    getUnreadCounts.mockResolvedValueOnce({ success: true, data: [] });

    await useReadStateStore.getState().fetchUnreadCounts(SERVER);

    // Nothing raced, so the server's word is the truth. This is why the fix is a re-fetch and not
    // a max(local, server) merge — a merge would keep painting a badge the user already cleared
    // somewhere else.
    expect(useReadStateStore.getState().unreadCounts[CHANNEL]).toBeUndefined();
  });

  it("should keep the badges when the request fails outright", async () => {
    useReadStateStore.setState({ unreadCounts: { [CHANNEL]: 4 } });
    getUnreadCounts.mockResolvedValueOnce({ success: false });

    await useReadStateStore.getState().fetchUnreadCounts(SERVER);

    // "It did not say" is not "everything is read".
    expect(useReadStateStore.getState().unreadCounts[CHANNEL]).toBe(4);
  });

  it("should ignore a snapshot that a newer fetch has superseded", async () => {
    let releaseFirst: (v: { success: boolean; data?: UnreadInfo[] }) => void = () => {};
    getUnreadCounts
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValueOnce({ success: true, data: [{ channel_id: CHANNEL, unread_count: 9 }] });

    const stale = useReadStateStore.getState().fetchUnreadCounts(SERVER);
    await useReadStateStore.getState().fetchUnreadCounts(SERVER);

    releaseFirst({ success: true, data: [{ channel_id: CHANNEL, unread_count: 1 }] });
    await stale;

    expect(useReadStateStore.getState().unreadCounts[CHANNEL]).toBe(9);
  });

  it("should stop re-fetching rather than loop when events keep racing", async () => {
    getUnreadCounts.mockImplementation(async () => {
      // Every snapshot is raced by a fresh arrival before it can be applied.
      queueMicrotask(() => useReadStateStore.getState().incrementUnread(CHANNEL));
      return { success: true, data: [{ channel_id: CHANNEL, unread_count: 1 }] };
    });

    await useReadStateStore.getState().fetchUnreadCounts(SERVER);
    await vi.waitFor(() =>
      expect(useReadStateStore.getState()._unreadFetch[SERVER]?.raced).toBe(false)
    );

    expect(getUnreadCounts.mock.calls.length).toBeLessThanOrEqual(4); // 1 + MAX_UNREAD_REFETCHES
  });

  it("should not let one server's events invalidate another server's snapshot", async () => {
    useReadStateStore.setState({
      channelServerMap: { [CHANNEL]: SERVER, "chan-2": "srv-2" },
    });
    getUnreadCounts.mockResolvedValue({
      success: true,
      data: [{ channel_id: CHANNEL, unread_count: 3 }],
    });

    const fetching = useReadStateStore.getState().fetchUnreadCounts(SERVER);
    // A message on a different server must not cost this one a re-fetch — fetchAllUnreadCounts
    // runs every server in parallel.
    useReadStateStore.getState().incrementUnread("chan-2");
    await fetching;

    expect(getUnreadCounts).toHaveBeenCalledTimes(1);
    expect(useReadStateStore.getState().unreadCounts[CHANNEL]).toBe(3);
  });
});
