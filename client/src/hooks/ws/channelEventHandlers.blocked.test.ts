/**
 * A blocked author's message must still land in the store (the list collapses it) but must
 * not raise unread or make noise — blocking is a promise that this person can no longer
 * interrupt you.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../crypto/channelEncryption", () => ({ decryptChannelMessage: vi.fn() }));
vi.mock("../../crypto/keyStorage", () => ({
  cacheDecryptedMessage: vi.fn(async () => {}),
  getCachedDecryptedMessage: vi.fn(async () => null),
}));
vi.mock("../../utils/sounds", () => ({ playNotificationSound: vi.fn() }));
vi.mock("../../i18n", () => ({ default: { t: (k: string) => k } }));

import { handleChannelEvent } from "./channelEventHandlers";
import { playNotificationSound } from "../../utils/sounds";
import { useAuthStore } from "../../stores/authStore";
import { useBlockStore } from "../../stores/blockStore";
import { useMessageStore } from "../../stores/messageStore";
import { useReadStateStore } from "../../stores/readStateStore";
import { useUIStore } from "../../stores/uiStore";
import type { Message, WSMessage } from "../../types";

const ME = "me";
const THEM = "them";
const CHANNEL = "c1";

function incoming(id: string, userId: string): WSMessage {
  const message = {
    id,
    channel_id: CHANNEL,
    user_id: userId,
    content: "hi",
    encryption_version: 0,
    created_at: "2026-09-12 10:00:00",
  } as Message;
  return { op: "message_create", d: message } as WSMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: ME, username: "me" } as never });
  // No active tab → the channel is not being viewed → a normal message raises unread.
  useUIStore.setState({ panels: {}, activePanelId: "none" } as never);
  useMessageStore.setState({ messagesByChannel: {} } as never);
  useReadStateStore.setState({ unreadCounts: {} } as never);
  useBlockStore.setState({ blockedUserIds: [] });
});

describe("message_create from a blocked author", () => {
  it("should store the message but not raise unread or play a sound when the author is blocked", async () => {
    useBlockStore.setState({ blockedUserIds: [THEM] });

    await handleChannelEvent(incoming("m1", THEM));

    expect(useMessageStore.getState().messagesByChannel[CHANNEL]?.map((m) => m.id)).toEqual(["m1"]);
    expect(useReadStateStore.getState().unreadCounts[CHANNEL] ?? 0).toBe(0);
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("should raise unread and play a sound for the same message when the author is not blocked", async () => {
    await handleChannelEvent(incoming("m1", THEM));

    expect(useReadStateStore.getState().unreadCounts[CHANNEL]).toBe(1);
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });
});
