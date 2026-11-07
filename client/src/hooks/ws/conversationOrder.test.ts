/**
 * Encrypted message events wait on decryption (IndexedDB, sometimes a sender-key fetch) while the
 * events about the same message that follow them do not. Without ordering, a delete or an edit
 * arriving during that wait was applied first — to a message not in the store yet — and the create
 * then landed the deleted or unedited message for good.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const decrypt = vi.hoisted(() => ({ release: [] as Array<() => void> }));
vi.mock("../../crypto/channelEncryption", () => ({
  decryptChannelMessage: vi.fn(
    (_userId: string, _channelId: string, ciphertext: string) =>
      new Promise((resolve) => decrypt.release.push(() => resolve({ content: `plain:${ciphertext}` }))),
  ),
}));
vi.mock("../../crypto/keyStorage", () => ({
  cacheDecryptedMessage: vi.fn(async () => {}),
  getCachedDecryptedMessage: vi.fn(async () => null),
}));
vi.mock("../../utils/sounds", () => ({ playNotificationSound: vi.fn() }));
vi.mock("../../i18n", () => ({ default: { t: (k: string) => k } }));

import { dispatchInConversationOrder } from "./conversationOrder";
import { handleChannelEvent } from "./channelEventHandlers";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useMessageStore } from "../../stores/messageStore";
import type { Message, User, WSMessage } from "../../types";

const CHANNEL = "c1";

function encryptedCreate(id: string): WSMessage {
  // Fixture: the fields the create handler reads.
  const message = {
    id, channel_id: CHANNEL, user_id: "them", content: null, ciphertext: id,
    sender_device_id: "d1", encryption_version: 1, created_at: "2026-11-07 10:00:00",
  } as unknown as Message;
  return { op: "message_create", d: message } as WSMessage;
}

function deleted(id: string): WSMessage {
  return { op: "message_delete", d: { id, channel_id: CHANNEL } } as WSMessage;
}

async function route(msg: WSMessage) {
  await handleChannelEvent(msg);
}

function storedIds(): string[] {
  return (useMessageStore.getState().messagesByChannel[CHANNEL] ?? []).map((m) => m.id);
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  decrypt.release.length = 0;
  // Fixture: only the id is read.
  useAuthStore.setState({ user: { id: "me" } as User });
  useE2EEStore.setState({ initStatus: "ready" });
  useMessageStore.setState({ messagesByChannel: { [CHANNEL]: [] } });
});

describe("dispatchInConversationOrder", () => {
  it("should not bring back a message deleted while it was still decrypting", async () => {
    const done = [dispatchInConversationOrder(encryptedCreate("m1"), route), dispatchInConversationOrder(deleted("m1"), route)];
    await flush();
    decrypt.release.forEach((release) => release());
    await Promise.all(done);

    expect(storedIds()).toEqual([]);
  });

  it("should store messages of one conversation in the order they arrived", async () => {
    const done = [dispatchInConversationOrder(encryptedCreate("m1"), route), dispatchInConversationOrder(encryptedCreate("m2"), route)];
    await flush();
    // The second message's decryption finishes first.
    decrypt.release.slice().reverse().forEach((release) => release());
    await flush();
    decrypt.release.forEach((release) => release());
    await Promise.all(done);

    expect(storedIds()).toEqual(["m1", "m2"]);
  });

  it("should not hold an unrelated event behind a decrypting message", async () => {
    const other = vi.fn(async () => {});
    const decrypting = dispatchInConversationOrder(encryptedCreate("m1"), route);

    await dispatchInConversationOrder({ op: "presence_update", d: { user_id: "u", status: "online" } } as WSMessage, other);

    expect(other).toHaveBeenCalledTimes(1);
    await flush();
    decrypt.release.forEach((release) => release());
    await decrypting;
  });

  it("should let a conversation move on when a decryption never finishes", async () => {
    vi.useFakeTimers();
    try {
      void dispatchInConversationOrder(encryptedCreate("stuck"), route);
      const next = vi.fn(async () => {});
      const queued = dispatchInConversationOrder(deleted("other"), next);

      await vi.advanceTimersByTimeAsync(10_000);
      await queued;

      expect(next).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
