/**
 * A cached DM is never decrypted again — a received message's ratchet key is spent once used — so
 * whatever the cache drops is gone for good on the next load. These pin that attachment keys survive.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DMMessage } from "../types";

const keyStorage = vi.hoisted(() => ({
  getCachedDecryptedMessage: vi.fn(),
  cacheDecryptedMessage: vi.fn(async () => {}),
  cacheDecryptedMessages: vi.fn(async () => {}),
}));
vi.mock("./keyStorage", () => keyStorage);

const { decryptDMMessages, isCacheable, persistSentPlaintext } = await import("./dmEncryption");
const { useE2EEStore } = await import("../stores/e2eeStore");

const fileKeys = [{ key: "k", iv: "iv", filename: "a.png", mimeType: "image/png", originalSize: 3, digest: "d" }];

beforeEach(() => {
  vi.clearAllMocks();
  useE2EEStore.setState({ initStatus: "ready", localDeviceId: "dev1" });
});

describe("DM message cache", () => {
  it("should give a message read from the cache its attachment keys", async () => {
    keyStorage.getCachedDecryptedMessage.mockResolvedValue({
      messageId: "m1", channelId: "", dmChannelId: "d1", content: "", timestamp: 1, fileKeys,
    });
    const raw = { id: "m1", dm_channel_id: "d1", user_id: "bob", encryption_version: 1, ciphertext: "[]", sender_device_id: "x" } as DMMessage;

    const [msg] = await decryptDMMessages([raw]);

    expect(msg.e2ee_file_keys).toEqual(fileKeys);
  });

  it("should cache an attachment-only message, not only one with text", () => {
    expect(isCacheable({ content: "", file_keys: fileKeys })).toBe(true);
    expect(isCacheable({ content: "hi" })).toBe(true);
    expect(isCacheable({ content: "" })).toBe(false);
  });

  it("should persist a sent message's attachment keys with its text", async () => {
    await persistSentPlaintext("m1", "d1", "caption", fileKeys);

    expect(keyStorage.cacheDecryptedMessage).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m1", fileKeys }));
  });
});
