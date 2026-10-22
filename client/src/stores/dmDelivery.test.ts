/**
 * The double tick: the recipient's app reports how far it received a DM, and the sender marks
 * its own messages up to there — including one whose send is confirmed after the report.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DMChannelWithUser, DMMessage, User } from "../types";

const dmApi = vi.hoisted(() => ({
  markDMDelivered: vi.fn(async () => ({ success: true })),
  markDMsDeliveredLatest: vi.fn<(ids: string[]) => Promise<{ success: boolean }>>(async () => ({ success: true })),
  listDMChannels: vi.fn(),
  getDMMessages: vi.fn(),
}));
vi.mock("../api/dm", () => dmApi);
vi.mock("../crypto/dmEncryption", () => ({ decryptDMMessages: vi.fn(async (m: unknown[]) => m) }));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));

const { useDMStore } = await import("./dmStore");
const { useAuthStore } = await import("./authStore");
const { reportDMDelivered, resetDMDeliveryReports, REPORT_DELAY_MS } = await import("./shared/dmDeliveryReports");
const { deliveryState } = await import("../utils/deliveryState");

const at = (s: number) => new Date(Date.UTC(2026, 9, 22, 10, 0, s)).toISOString();
const dm = (id: string, user: string, s: number) => ({ id, dm_channel_id: "d1", user_id: user, created_at: at(s) }) as DMMessage;
const delivered = () => Object.fromEntries((useDMStore.getState().messagesByChannel["d1"] ?? []).map((m) => [m.id, !!m.delivered]));
const settle = () => new Promise((r) => setTimeout(r, REPORT_DELAY_MS + 50));

beforeEach(() => {
  vi.clearAllMocks();
  resetDMDeliveryReports();
  useAuthStore.setState({ user: { id: "me" } as User });
  useDMStore.setState({ messagesByChannel: {}, deliveredMarks: {}, channels: [] });
});

describe("sender: applying dm_delivered", () => {
  it("should mark own messages up to the reported one, and nobody else's", () => {
    useDMStore.setState({ messagesByChannel: { d1: [dm("a", "me", 1), dm("b", "them", 2), dm("c", "me", 3), dm("d", "me", 4)] } });

    useDMStore.getState().handleDMDelivered({ dm_channel_id: "d1", message_id: "c", created_at: at(3) });

    expect(delivered()).toEqual({ a: true, b: false, c: true, d: false });
  });

  it("should judge a mark it does not hold by time, leaving its own second undecided", () => {
    useDMStore.setState({ messagesByChannel: { d1: [dm("a", "me", 1), dm("b", "me", 5)] } });

    useDMStore.getState().handleDMDelivered({ dm_channel_id: "d1", message_id: "elsewhere", created_at: at(5) });

    expect(delivered()).toEqual({ a: true, b: false });
  });

  it("should tick an own send confirmed after the other app already reported it", () => {
    useDMStore.setState({ messagesByChannel: { d1: [dm("a", "me", 1)] } });
    useDMStore.getState().handleDMDelivered({ dm_channel_id: "d1", message_id: "late", created_at: at(2) });

    useDMStore.getState().handleDMMessageCreate(dm("late", "me", 2));

    expect(delivered()).toEqual({ a: true, late: true });
  });
});

describe("recipient: reporting", () => {
  it("should report a burst once, with its newest message", async () => {
    reportDMDelivered("d1", "m1");
    reportDMDelivered("d1", "m2");
    await settle();

    expect(dmApi.markDMDelivered).toHaveBeenCalledTimes(1);
    expect(dmApi.markDMDelivered).toHaveBeenCalledWith("d1", "m2");
  });

  it("should not report the same message twice, but should after a failure", async () => {
    reportDMDelivered("d1", "m1");
    await settle();
    reportDMDelivered("d1", "m1");
    await settle();
    expect(dmApi.markDMDelivered).toHaveBeenCalledTimes(1);

    dmApi.markDMDelivered.mockResolvedValueOnce({ success: false });
    reportDMDelivered("d1", "m2");
    await settle();
    reportDMDelivered("d1", "m2");
    await settle();
    expect(dmApi.markDMDelivered).toHaveBeenCalledTimes(3);
  });

  it("should report a fetched page's newest message from the other participant", async () => {
    dmApi.getDMMessages.mockResolvedValue({ success: true, data: { messages: [dm("x", "them", 1), dm("y", "me", 2)], has_more: false } });

    await useDMStore.getState().fetchMessages("d1");
    await settle();

    expect(dmApi.markDMDelivered).toHaveBeenCalledWith("d1", "x");
  });

  it("should report every conversation with news in one request after connecting", async () => {
    dmApi.listDMChannels.mockResolvedValue({
      success: true,
      data: [{ id: "d1", unread_count: 2 }, { id: "d2", unread_count: 0 }, { id: "d3", unread_count: 1 }] as DMChannelWithUser[],
    });

    await useDMStore.getState().fetchChannels();

    expect(dmApi.markDMsDeliveredLatest).toHaveBeenCalledTimes(1);
    expect(dmApi.markDMsDeliveredLatest).toHaveBeenCalledWith(["d1", "d3"]);
  });

  it("should not report again a conversation whose newest message has not changed", async () => {
    const list = (d1At: string) => ({
      success: true,
      data: [{ id: "d1", unread_count: 2, last_message_at: d1At }, { id: "d3", unread_count: 1, last_message_at: at(3) }] as DMChannelWithUser[],
    });
    dmApi.listDMChannels.mockResolvedValue(list(at(1)));
    await useDMStore.getState().fetchChannels();

    dmApi.listDMChannels.mockResolvedValue(list(at(1)));
    await useDMStore.getState().fetchChannels(); // a reconnect with nothing new

    dmApi.listDMChannels.mockResolvedValue(list(at(9)));
    await useDMStore.getState().fetchChannels(); // d1 got a new message

    expect(dmApi.markDMsDeliveredLatest.mock.calls.map((c) => c[0])).toEqual([["d1", "d3"], ["d1"]]);
  });
});

describe("deliveryState", () => {
  it("should show the double tick in a DM only", () => {
    expect(deliveryState(true, "dm", undefined, true)).toBe("delivered");
    expect(deliveryState(true, "channel", undefined, true)).toBe("sent");
    expect(deliveryState(true, "dm", undefined, false)).toBe("sent");
  });
});
