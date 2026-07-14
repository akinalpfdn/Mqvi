/**
 * The unread badge is derived from events, and an event about a message we do not hold tells us
 * almost nothing. These tests pin down what the delete handler is allowed to infer.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../crypto/dmEncryption", () => ({
  decryptDMMessage: vi.fn(),
  popSentPlaintext: vi.fn(),
  popEditPlaintext: vi.fn(),
}));
vi.mock("../../crypto/keyStorage", () => ({
  cacheDecryptedMessage: vi.fn(async () => {}),
  getCachedDecryptedMessage: vi.fn(async () => null),
}));
vi.mock("../../utils/sounds", () => ({ playNotificationSound: vi.fn() }));
vi.mock("../../i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("../../api/dm", () => ({
  markDMRead: vi.fn(async () => ({ success: true })),
  listDMChannels: vi.fn(async () => ({ success: false })),
  getDMMessages: vi.fn(async () => ({ success: false })),
  getDMSettings: vi.fn(async () => ({ success: false })),
  hideDM: vi.fn(), pinDMConversation: vi.fn(), unpinDMConversation: vi.fn(),
  muteDM: vi.fn(), unmuteDM: vi.fn(),
}));
vi.mock("../../stores/toastStore", () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));
vi.mock("../../utils/pushDismiss", () => ({
  dismissNotificationsFor: vi.fn(async () => {}),
  dismissReadNotifications: vi.fn(async () => {}),
}));

import { handleDMEvent } from "./dmEventHandlers";
import { useDMStore } from "../../stores/dmStore";
import { useAuthStore } from "../../stores/authStore";
import { useAppFocusStore } from "../../stores/appFocusStore";
import type { DMMessage, WSMessage } from "../../types";

const ME = "me";
const THEM = "them";

function msg(id: string, userId: string): DMMessage {
  return {
    id,
    dm_channel_id: "c1",
    user_id: userId,
    content: "hi",
    encryption_version: 0,
    created_at: "2026-07-14 10:00:00",
  } as DMMessage;
}

function deleteEvent(id: string): WSMessage {
  return { op: "dm_message_delete", d: { id, dm_channel_id: "c1" } } as WSMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: ME, username: "me" } as never });
  useAppFocusStore.setState({ isForeground: false });
  useDMStore.setState({
    messagesByChannel: {},
    dmUnreadCounts: { c1: 2 },
    channels: [],
    _unreadFetchGen: 0,
    _unreadFetchActive: false,
    _unreadFetchRaced: false,
    _unreadRefetches: 0,
  });
});

describe("dm_message_delete — what the badge may infer", () => {
  it("drops the badge by one when THEIR unread message is deleted", async () => {
    useDMStore.setState({ messagesByChannel: { c1: [msg("m1", THEM)] } });

    await handleDMEvent(deleteEvent("m1"));

    expect(useDMStore.getState().dmUnreadCounts.c1).toBe(1);
  });

  // The bug: on an unloaded conversation the old code looked up the message, got `undefined`,
  // and `undefined?.user_id !== myId` is true — so deleting your OWN message decremented the
  // badge counting the OTHER person's messages.
  it("leaves the badge alone when we deleted our own message", async () => {
    useDMStore.setState({ messagesByChannel: { c1: [msg("m1", ME)] } });

    await handleDMEvent(deleteEvent("m1"));

    expect(useDMStore.getState().dmUnreadCounts.c1).toBe(2);
  });

  // Not holding the message means we cannot tell whose it was, or whether it was ever counted.
  // Guessing is what produced the bug above. Leave it; the next server snapshot settles it.
  it("leaves the badge alone for a message the conversation never loaded", async () => {
    useDMStore.setState({ messagesByChannel: {} });

    await handleDMEvent(deleteEvent("ghost"));

    expect(useDMStore.getState().dmUnreadCounts.c1).toBe(2);
  });
});

describe("dm_read — a read on another device", () => {
  it("clears the badge here when the other device read the whole conversation", async () => {
    await handleDMEvent({
      op: "dm_read",
      d: { dm_channel_id: "c1", unread_count: 0 },
    } as WSMessage);

    expect(useDMStore.getState().dmUnreadCounts.c1).toBeUndefined();
  });

  it("adopts the server's count rather than assuming zero", async () => {
    await handleDMEvent({
      op: "dm_read",
      d: { dm_channel_id: "c1", unread_count: 5 },
    } as WSMessage);

    expect(useDMStore.getState().dmUnreadCounts.c1).toBe(5);
  });
});

// REVIEW-01 #8: the increment gate must agree with the mark-read gate. Selection alone is not
// enough — a selected DM in a backgrounded window is NOT read, and the server (which now owns
// unread) counts it unread and pushes to the phone. Before this, the one conversation the desktop
// stayed completely silent about was the one it had open.
describe("dm_message_create — the badge gate matches the read gate", () => {
  function incoming(): WSMessage {
    return { op: "dm_message_create", d: msg("new-1", THEM) } as WSMessage;
  }

  it("raises the badge for a selected DM when the app is in the background", async () => {
    useDMStore.setState({ selectedDMId: "c1", dmUnreadCounts: {} });
    useAppFocusStore.setState({ isForeground: false });

    await handleDMEvent(incoming());

    expect(useDMStore.getState().dmUnreadCounts.c1).toBe(1);
  });

  // Cold start: the native app state has not answered yet. "Unknown" is not "in front of it" —
  // claiming otherwise would suppress the badge AND the read, on nothing but a guess.
  it("raises the badge while the foreground state is still unknown", async () => {
    useDMStore.setState({ selectedDMId: "c1", dmUnreadCounts: {} });
    useAppFocusStore.setState({ isForeground: null });

    await handleDMEvent(incoming());

    expect(useDMStore.getState().dmUnreadCounts.c1).toBe(1);
  });

  // Actually looking at it: DMChat marks it read, so a badge here would be wrong.
  it("stays silent when the DM is selected AND the app is in the foreground", async () => {
    useDMStore.setState({ selectedDMId: "c1", dmUnreadCounts: {} });
    useAppFocusStore.setState({ isForeground: true });

    await handleDMEvent(incoming());

    expect(useDMStore.getState().dmUnreadCounts.c1).toBeUndefined();
  });
});
