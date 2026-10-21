/**
 * Optimistic send: a message shows at once, is confirmed by whichever of the send response and the
 * echo arrives first, and on a lost answer is retried under the nonce it already had — so the
 * server, which dedupes on that nonce, stores it once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { DMChannelWithUser, DMMessage, Message, User } from "../types";

const messageApi = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  sendEncryptedMessage: vi.fn(),
  getMessages: vi.fn(),
}));
vi.mock("../api/messages", () => messageApi);

const dmApi = vi.hoisted(() => ({
  sendDMMessage: vi.fn(),
  sendEncryptedDMMessage: vi.fn(),
  getDMMessages: vi.fn(),
  listDMChannels: vi.fn(async () => ({ success: false })),
}));
vi.mock("../api/dm", () => dmApi);

const dmCrypto = vi.hoisted(() => ({
  encryptDMMessage: vi.fn(),
  decryptDMMessages: vi.fn(async (m: unknown[]) => m),
  decryptDMMessage: vi.fn(),
  persistSentPlaintext: vi.fn(async () => {}),
  cacheEditPlaintext: vi.fn(),
  popEditPlaintext: vi.fn(),
}));
vi.mock("../crypto/dmEncryption", () => dmCrypto);
vi.mock("../crypto/channelEncryption", () => ({
  encryptChannelMessage: vi.fn(),
  decryptChannelMessages: vi.fn(async (m: unknown[]) => m),
  decryptChannelMessage: vi.fn(),
}));
vi.mock("../crypto/keyStorage", () => ({
  cacheDecryptedMessage: vi.fn(async () => {}),
  getCachedDecryptedMessage: vi.fn(async () => null),
}));

const toast = vi.hoisted(() => vi.fn());
vi.mock("./toastStore", () => ({ useToastStore: { getState: () => ({ addToast: toast }) } }));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("../utils/sounds", () => ({ playNotificationSound: vi.fn() }));

const { useMessageStore } = await import("./messageStore");
const { useDMStore } = await import("./dmStore");
const { useOutboxStore, resetOutbox, SEND_TIMEOUT_MS, classifyFailure } = await import("./outboxStore");
const { useServerStore } = await import("./serverStore");
const { useAuthStore } = await import("./authStore");
const { useE2EEStore } = await import("./e2eeStore");
const { handleDMEvent } = await import("../hooks/ws/dmEventHandlers");

const me = { id: "me", username: "me" } as User;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const stored = (id: string, nonce: string, extra: Partial<Message> = {}): Message =>
  ({ id, channel_id: "c1", user_id: "me", content: "hi", client_nonce: nonce, author: me, ...extra }) as Message;

const pendingIn = (conversationId: string) => useOutboxStore.getState().pendingByConversation[conversationId] ?? [];
const channelIds = () => (useMessageStore.getState().messagesByChannel["c1"] ?? []).map((m) => m.id);
/** The nonce the store handed the API: the 8th argument of sendMessage. */
const sentNonce = (call: number) => messageApi.sendMessage.mock.calls[call][7] as string;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetOutbox();
  vi.clearAllMocks();
  useAuthStore.setState({ user: me });
  useServerStore.setState({ servers: [{ id: "s1", e2ee_enabled: false }] as never, activeServerId: "s1", activeServer: null });
  useMessageStore.setState({ messagesByChannel: { c1: [] } });
  useDMStore.setState({
    channels: [{ id: "d1", e2ee_enabled: false, other_user: { id: "bob" } } as DMChannelWithUser],
    messagesByChannel: { d1: [] },
  });
  useE2EEStore.setState({ initStatus: "ready", localDeviceId: "dev1" });
  URL.createObjectURL = vi.fn(() => "blob:local");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("optimistic channel send", () => {
  it("should show the message as pending before the server answers", async () => {
    messageApi.sendMessage.mockReturnValue(new Promise(() => {}));

    const queued = await useMessageStore.getState().sendMessage("c1", "hi");

    expect(queued).toBe(true);
    expect(pendingIn("c1").map((p) => p.content)).toEqual(["hi"]);
    expect(pendingIn("c1")[0].status).toBe("sending");
  });

  it("should replace the pending copy with the stored message when the response arrives", async () => {
    messageApi.sendMessage.mockImplementation(async (...args: unknown[]) => ({
      success: true, data: stored("m1", args[7] as string),
    }));

    await useMessageStore.getState().sendMessage("c1", "hi");
    await flush();

    expect(pendingIn("c1")).toEqual([]);
    expect(channelIds()).toEqual(["m1"]);
  });

  it("should keep one copy when the echo arrives before the response", async () => {
    const response = deferred<unknown>();
    messageApi.sendMessage.mockReturnValue(response.promise);
    await useMessageStore.getState().sendMessage("c1", "hi");
    await flush();
    const nonce = sentNonce(0);

    useMessageStore.getState().handleMessageCreate(stored("m1", nonce));
    expect(pendingIn("c1")).toEqual([]);

    response.resolve({ success: true, data: stored("m1", nonce) });
    await flush();
    expect(channelIds()).toEqual(["m1"]);
  });

  it("should not let another user's message settle this device's pending send", async () => {
    messageApi.sendMessage.mockReturnValue(new Promise(() => {}));
    await useMessageStore.getState().sendMessage("c1", "hi");
    await flush();

    useMessageStore.getState().handleMessageCreate(stored("x1", sentNonce(0), { user_id: "mallory" }));

    expect(pendingIn("c1")).toHaveLength(1);
  });

  it("should retry a lost send under the same nonce", async () => {
    messageApi.sendMessage.mockResolvedValueOnce({ success: false, httpStatus: 0, error: "Network request failed" });
    await useMessageStore.getState().sendMessage("c1", "hi");
    await flush();
    expect(pendingIn("c1")[0]).toMatchObject({ status: "failed", failure: "transient" });

    messageApi.sendMessage.mockImplementationOnce(async (...args: unknown[]) => ({
      success: true, data: stored("m1", args[7] as string),
    }));
    useMessageStore.getState().retryPending(pendingIn("c1")[0].nonce);
    await flush();

    expect(sentNonce(1)).toBe(sentNonce(0));
    expect(channelIds()).toEqual(["m1"]);
    expect(pendingIn("c1")).toEqual([]);
  });

  it("should rebuild a refused send on retry, and repeat a lost one exactly", async () => {
    const { encryptChannelMessage } = await import("../crypto/channelEncryption");
    vi.mocked(encryptChannelMessage).mockResolvedValue({ distributionId: "dist" } as never);
    useServerStore.setState({ servers: [{ id: "s1", e2ee_enabled: true }] as never });
    messageApi.sendEncryptedMessage
      .mockResolvedValueOnce({ success: false, httpStatus: 0 })
      .mockResolvedValueOnce({ success: false, httpStatus: 400, code: "encryption_not_available" })
      .mockResolvedValueOnce({ success: false, httpStatus: 0 });

    await useMessageStore.getState().sendMessage("c1", "hi");
    await flush();
    const nonce = pendingIn("c1")[0].nonce;
    useMessageStore.getState().retryPending(nonce); // lost before: same request again
    await flush();
    useMessageStore.getState().retryPending(nonce); // refused before: built afresh
    await flush();

    expect(encryptChannelMessage).toHaveBeenCalledTimes(2);
  });

  it("should fail a send that gets no answer within the timeout, and abort its request", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    messageApi.sendMessage.mockImplementation((...args: unknown[]) => {
      signal = (args[5] as { signal: AbortSignal }).signal;
      return new Promise(() => {});
    });

    await useMessageStore.getState().sendMessage("c1", "hi");
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);

    expect(signal?.aborted).toBe(true);
    expect(pendingIn("c1")[0]).toMatchObject({ status: "failed", failure: "transient" });
  });

  it("should not toast a transient failure — the bubble shows it", async () => {
    messageApi.sendMessage.mockResolvedValue({ success: false, httpStatus: 503, error: "unavailable" });

    await useMessageStore.getState().sendMessage("c1", "hi");
    await flush();

    expect(toast).not.toHaveBeenCalled();
  });

  it("should send a conversation's messages one after another", async () => {
    const first = deferred<unknown>();
    messageApi.sendMessage.mockReturnValueOnce(first.promise);
    messageApi.sendMessage.mockImplementationOnce(async (...args: unknown[]) => ({
      success: true, data: stored("m2", args[7] as string),
    }));

    await useMessageStore.getState().sendMessage("c1", "one");
    await useMessageStore.getState().sendMessage("c1", "two");
    await flush();
    expect(messageApi.sendMessage).toHaveBeenCalledTimes(1);

    first.resolve({ success: true, data: stored("m1", sentNonce(0)) });
    await flush();
    await flush();

    expect(messageApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(channelIds()).toEqual(["m1", "m2"]);
  });

  it("should give a held copy that could not be decrypted the content the confirmation brings", async () => {
    useMessageStore.setState({ messagesByChannel: { c1: [stored("m1", "n", { content: null })] } });

    useMessageStore.getState().handleMessageCreate(stored("m1", "n", { content: "hello" }));

    expect(useMessageStore.getState().messagesByChannel["c1"][0].content).toBe("hello");
  });

  it("should queue nothing when the server's encryption state is unknown", async () => {
    useServerStore.setState({ servers: [{ id: "s1" }] as never });

    const queued = await useMessageStore.getState().sendMessage("c1", "hi");

    expect(queued).toBe(false);
    expect(pendingIn("c1")).toEqual([]);
    expect(messageApi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("retrying after a reconnect", () => {
  it("should retry transient text failures and leave rejected ones and files to the user", async () => {
    messageApi.sendMessage
      .mockResolvedValueOnce({ success: false, httpStatus: 0 }) // text, lost
      .mockResolvedValueOnce({ success: false, httpStatus: 403, error: "forbidden" }) // text, refused
      .mockResolvedValueOnce({ success: false, httpStatus: 0 }); // file, lost
    await useMessageStore.getState().sendMessage("c1", "lost");
    await useMessageStore.getState().sendMessage("c1", "refused");
    await useMessageStore.getState().sendMessage("c1", "file", [new File(["x"], "a.txt")]);
    await flush();
    await flush();
    expect(pendingIn("c1").map((p) => p.status)).toEqual(["failed", "failed", "failed"]);

    messageApi.sendMessage.mockResolvedValue({ success: false, httpStatus: 0 });
    useMessageStore.getState().retryFailedSends();
    await flush();

    expect(messageApi.sendMessage).toHaveBeenCalledTimes(4);
    expect(messageApi.sendMessage.mock.calls[3][2]).toBe("lost");
  });
});

describe("failure classes", () => {
  it.each([
    [0, "transient"], [undefined, "transient"], [408, "transient"], [502, "transient"],
    // Told "too fast" at the time; going out by itself at some later reconnect would surprise.
    [429, "rejected"], [403, "rejected"], [400, "rejected"],
  ])("should classify HTTP %s as %s", (status, want) => {
    expect(classifyFailure(status)).toBe(want);
  });
});

describe("waiting for delivery", () => {
  it("should resolve true only once the server stored the message", async () => {
    dmApi.sendDMMessage.mockResolvedValueOnce({ success: false, httpStatus: 0 });
    expect(await useDMStore.getState().sendMessageAndWait("d1", "invite")).toBe(false);
    expect(pendingIn("d1")[0].status).toBe("failed");

    dmApi.sendDMMessage.mockImplementationOnce(async (...args: unknown[]) => ({
      success: true,
      data: { id: "m1", dm_channel_id: "d1", user_id: "me", content: "invite", client_nonce: args[6] } as DMMessage,
    }));
    expect(await useDMStore.getState().sendMessageAndWait("d1", "invite")).toBe(true);
  });
});

describe("cancel and sign-out", () => {
  it("should drop a message whose upload the user cancelled, not mark it failed", async () => {
    messageApi.sendMessage.mockImplementation((...args: unknown[]) => {
      const { signal } = args[5] as { signal: AbortSignal };
      return new Promise((resolve) => signal.addEventListener("abort", () =>
        resolve({ success: false, httpStatus: 0, code: "UPLOAD_ABORTED" })));
    });
    await useMessageStore.getState().sendMessage("c1", "pic", [new File(["x"], "a.png", { type: "image/png" })]);
    await flush();

    useMessageStore.getState().discardPending(pendingIn("c1")[0].nonce);
    await flush();

    expect(pendingIn("c1")).toEqual([]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local");
  });

  it("should leave nothing queued for the next account after sign-out", async () => {
    messageApi.sendMessage.mockResolvedValue({ success: false, httpStatus: 0 });
    await useMessageStore.getState().sendMessage("c1", "hi");
    await flush();

    resetOutbox();
    useMessageStore.getState().retryFailedSends();
    await flush();

    expect(pendingIn("c1")).toEqual([]);
    expect(messageApi.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("encrypted DM own echo", () => {
  const dmEcho = (id: string, nonce: string): DMMessage =>
    ({
      id, dm_channel_id: "d1", user_id: "me", content: null, client_nonce: nonce, author: me,
      encryption_version: 1, ciphertext: "[]", sender_device_id: "dev1", created_at: "2026-10-21T10:00:00Z",
    }) as DMMessage;

  beforeEach(() => {
    useDMStore.setState({
      channels: [{ id: "d1", e2ee_enabled: true, other_user: { id: "bob" } } as DMChannelWithUser],
    });
    dmCrypto.encryptDMMessage.mockResolvedValue([]);
    dmApi.sendEncryptedDMMessage.mockReturnValue(new Promise(() => {}));
  });

  it("should give each own echo its own text even when they arrive out of order", async () => {
    await useDMStore.getState().sendMessage("d1", "first");
    await useDMStore.getState().sendMessage("d1", "second");
    await flush();
    const [first, second] = pendingIn("d1").map((p) => p.nonce);

    // Matched on the nonce each echo carries, not on arrival order: a retry whose first attempt
    // already landed produces no echo, and an order-based match then shifts every later text.
    await handleDMEvent({ op: "dm_message_create", d: dmEcho("m2", second) } as never);
    await handleDMEvent({ op: "dm_message_create", d: dmEcho("m1", first) } as never);

    const byId = Object.fromEntries((useDMStore.getState().messagesByChannel["d1"] ?? []).map((m) => [m.id, m.content]));
    expect(byId).toEqual({ m2: "second", m1: "first" });
    expect(dmCrypto.decryptDMMessage).not.toHaveBeenCalled();
  });

  it("should persist the text before the pending copy goes", async () => {
    let nonce = "";
    dmApi.sendEncryptedDMMessage.mockImplementation(async (...args: unknown[]) => {
      nonce = args[8] as string;
      return { success: true, data: { ...dmEcho("m1", nonce), content: null } };
    });
    // Read, not asserted, inside the write: the store swallows a failing write, so an expect
    // thrown there would vanish.
    let pendingDuringWrite = false;
    dmCrypto.persistSentPlaintext.mockImplementation(async () => {
      pendingDuringWrite = useOutboxStore.getState().find(nonce) !== undefined;
    });

    await useDMStore.getState().sendMessage("d1", "secret");
    await flush();

    // Still pending while the write ran: an echo landing then still found its text.
    expect(pendingDuringWrite).toBe(true);
    expect(dmCrypto.persistSentPlaintext).toHaveBeenCalledWith("m1", "d1", "secret", undefined);
    expect(useDMStore.getState().messagesByChannel["d1"].map((m) => m.content)).toEqual(["secret"]);
    expect(pendingIn("d1")).toEqual([]);
  });
});
