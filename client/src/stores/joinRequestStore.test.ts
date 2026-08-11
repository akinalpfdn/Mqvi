/**
 * The sidebar badge after a join request is decided.
 *
 * The requests screen filtered its own list on success and never touched the count, so approving a
 * request made the row vanish while the sidebar still showed a pending badge — until
 * join_request_update arrived to correct it, or forever if the socket was down. Nothing here waits
 * for that event.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const api = vi.hoisted(() => ({
  getJoinRequestCount: vi.fn(),
  approveJoinRequest: vi.fn(),
  rejectJoinRequest: vi.fn(),
}));
vi.mock("../api/joinRequests", () => api);

const { useJoinRequestStore } = await import("./joinRequestStore");

const ok = { success: true as const, data: { message: "ok" } };
const fail = (error?: string) => ({ success: false as const, error });

const count = () => useJoinRequestStore.getState().pendingCounts["s1"];

beforeEach(() => {
  vi.clearAllMocks();
  useJoinRequestStore.setState({ pendingCounts: { s1: 3 } });
});

describe("deciding a join request", () => {
  it("should drop the badge by one on approve, with no WS event", async () => {
    api.approveJoinRequest.mockResolvedValue(ok);

    expect((await useJoinRequestStore.getState().approve("s1", "u1")).ok).toBe(true);

    expect(count()).toBe(2);
  });

  it("should drop the badge by one on reject, with no WS event", async () => {
    api.rejectJoinRequest.mockResolvedValue(ok);

    expect((await useJoinRequestStore.getState().reject("s1", "u1")).ok).toBe(true);

    expect(count()).toBe(2);
  });

  it("should leave the badge alone when the server refuses, and say why", async () => {
    api.approveJoinRequest.mockResolvedValue(fail("request already handled"));

    const res = await useJoinRequestStore.getState().approve("s1", "u1");

    expect(res.ok).toBe(false);
    expect(res.error).toBe("request already handled");
    expect(count()).toBe(3);
  });

  it("should let the authoritative count from the echo overwrite the local guess", async () => {
    api.approveJoinRequest.mockResolvedValue(ok);
    await useJoinRequestStore.getState().approve("s1", "u1");

    // What join_request_update does. It is a set, not a decrement, so it cannot compound.
    useJoinRequestStore.getState().setPendingCount("s1", 2);

    expect(count()).toBe(2);
  });

  // Two moderators clearing the queue at the same time, or a stale badge already at zero. A
  // negative count renders as a badge that never goes away.
  it("should not go below zero", async () => {
    useJoinRequestStore.setState({ pendingCounts: { s1: 0 } });
    api.rejectJoinRequest.mockResolvedValue(ok);

    await useJoinRequestStore.getState().reject("s1", "u1");

    expect(count()).toBe(0);
  });

  it("should not disturb another server's count", async () => {
    useJoinRequestStore.setState({ pendingCounts: { s1: 3, s2: 5 } });
    api.approveJoinRequest.mockResolvedValue(ok);

    await useJoinRequestStore.getState().approve("s1", "u1");

    expect(useJoinRequestStore.getState().pendingCounts["s2"]).toBe(5);
  });
});
