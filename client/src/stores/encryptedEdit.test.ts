/**
 * An encrypted edit replaces the stored ciphertext. Text alone in it erased the attachment keys
 * for every reader, so the edit carries them — and is refused where this device lacks them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { DMChannelWithUser, DMMessage, Message, User } from "../types";
import type { EncryptedFileMeta } from "../crypto/fileEncryption";

const messageApi = vi.hoisted(() => ({ editEncryptedMessage: vi.fn(async () => ({ success: true })) }));
vi.mock("../api/messages", () => messageApi);
const dmApi = vi.hoisted(() => ({ editEncryptedDMMessage: vi.fn(async () => ({ success: true })) }));
vi.mock("../api/dm", () => dmApi);

const channelCrypto = vi.hoisted(() => ({
  encryptChannelMessage: vi.fn(async () => ({ distributionId: "dist" })),
  decryptChannelMessages: vi.fn(),
}));
vi.mock("../crypto/channelEncryption", () => channelCrypto);
const dmCrypto = vi.hoisted(() => ({
  encryptDMMessage: vi.fn(async () => []),
  decryptDMMessages: vi.fn(),
  persistSentPlaintext: vi.fn(async () => {}),
  cacheEditPlaintext: vi.fn(),
}));
vi.mock("../crypto/dmEncryption", () => dmCrypto);

const toast = vi.hoisted(() => vi.fn());
vi.mock("./toastStore", () => ({ useToastStore: { getState: () => ({ addToast: toast }) } }));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));

const { useMessageStore } = await import("./messageStore");
const { useDMStore } = await import("./dmStore");
const { useServerStore } = await import("./serverStore");
const { useAuthStore } = await import("./authStore");
const { useE2EEStore } = await import("./e2eeStore");
const { decodePayload } = await import("../crypto/e2eePayload");

const keys: EncryptedFileMeta[] = [
  { key: "k", iv: "iv", filename: "a.png", mimeType: "image/png", originalSize: 3, digest: "d" },
];
const withFile = { attachments: [{ id: "f1" }] };

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user: { id: "me" } as User });
  useE2EEStore.setState({ initStatus: "ready", localDeviceId: "dev1" });
  useServerStore.setState({ servers: [{ id: "s1", e2ee_enabled: true }] as never, activeServerId: "s1" });
  useDMStore.setState({
    channels: [{ id: "d1", e2ee_enabled: true, other_user: { id: "bob" } } as DMChannelWithUser],
  });
});

/** The plaintext handed to the encrypt call, decoded the way a reader decodes it. */
const encrypted = (fn: ReturnType<typeof vi.fn>) => decodePayload(fn.mock.calls[0][3] as string);

describe("encrypted channel edit", () => {
  it("should carry the attachment keys with the new text", async () => {
    useMessageStore.setState({
      messagesByChannel: { c1: [{ id: "m1", ...withFile, e2ee_file_keys: keys } as unknown as Message] },
    });

    expect(await useMessageStore.getState().editMessage("m1", "new caption", "s1")).toBe(true);

    expect(encrypted(channelCrypto.encryptChannelMessage)).toEqual({ content: "new caption", file_keys: keys });
  });

  it("should refuse the edit when this device does not hold the attachment keys", async () => {
    useMessageStore.setState({ messagesByChannel: { c1: [{ id: "m1", ...withFile } as unknown as Message] } });

    expect(await useMessageStore.getState().editMessage("m1", "new caption", "s1")).toBe(false);

    expect(messageApi.editEncryptedMessage).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("error", "e2ee:editAttachmentKeysMissing");
  });
});

describe("encrypted DM edit", () => {
  it("should carry the keys and cache the edit under its conversation", async () => {
    useDMStore.setState({
      messagesByChannel: { d1: [{ id: "m1", ...withFile, e2ee_file_keys: keys } as unknown as DMMessage] },
    });

    expect(await useDMStore.getState().editMessage("m1", "new caption")).toBe(true);

    expect(encrypted(dmCrypto.encryptDMMessage)).toEqual({ content: "new caption", file_keys: keys });
    // The conversation id is what DM search filters on.
    expect(dmCrypto.persistSentPlaintext).toHaveBeenCalledWith("m1", "d1", "new caption", keys);
  });

  it("should refuse the edit when this device does not hold the attachment keys", async () => {
    useDMStore.setState({ messagesByChannel: { d1: [{ id: "m1", ...withFile } as unknown as DMMessage] } });

    expect(await useDMStore.getState().editMessage("m1", "new caption")).toBe(false);

    expect(dmApi.editEncryptedDMMessage).not.toHaveBeenCalled();
  });

  it("should edit a message without attachments as before", async () => {
    useDMStore.setState({ messagesByChannel: { d1: [{ id: "m1", attachments: [] } as unknown as DMMessage] } });

    expect(await useDMStore.getState().editMessage("m1", "text")).toBe(true);

    expect(encrypted(dmCrypto.encryptDMMessage)).toEqual({ content: "text", file_keys: undefined });
  });
});
