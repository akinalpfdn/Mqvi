/**
 * E2EE init is a startup race: the app renders, the user opens a conversation, and the keys are
 * still loading. What the client does in that window used to differ per surface — the DM fetch
 * refused outright (so plaintext conversations rendered empty, and stayed empty forever if init
 * ended in error), while the channel fetch cached placeholders that nothing ever refilled.
 *
 * These tests pin the single rule both surfaces now follow: fetch regardless, leave placeholders
 * for what cannot be read yet, and refill once the keys land — without wiping a cache that was
 * never gated.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../crypto/deviceManager", () => ({
  getLocalDeviceId: vi.fn(async () => "device-1"),
  registerNewDevice: vi.fn(),
  registerRestoredDevice: vi.fn(),
  refreshPreKeys: vi.fn(async () => {}),
  reRegisterDevice: vi.fn(async () => {}),
}));
vi.mock("../crypto/keyBackup", () => ({ createBackup: vi.fn(), restoreFromBackup: vi.fn() }));
vi.mock("../crypto/keyStorage", () => ({
  hasLocalKeys: vi.fn(async () => true),
  getRegistrationData: vi.fn(async () => ({ userId: "user-1", registrationId: 1 })),
  clearAllE2EEData: vi.fn(async () => {}),
  getCachedDecryptedMessage: vi.fn(async () => null),
  cacheDecryptedMessage: vi.fn(async () => {}),
  cacheDecryptedMessages: vi.fn(async () => {}),
}));
vi.mock("../crypto/signalProtocol", () => ({
  decryptMessage: vi.fn(async () => "should not be reached"),
  encryptMessage: vi.fn(),
  processPreKeyBundle: vi.fn(),
  hasSessionFor: vi.fn(async () => true),
}));
vi.mock("../crypto/channelEncryption", () => ({
  decryptChannelMessages: vi.fn(async (m: unknown[]) => m),
  encryptChannelMessage: vi.fn(),
}));
vi.mock("../api/e2ee", () => ({
  listMyDevices: vi.fn(async () => ({ success: true, data: [{ device_id: "device-1" }] })),
  removeDevice: vi.fn(),
  uploadKeyBackup: vi.fn(),
  downloadKeyBackup: vi.fn(async () => ({ success: false })),
}));
vi.mock("../api/dm", () => ({ getDMMessages: vi.fn() }));
vi.mock("../api/messages", () => ({ getMessages: vi.fn(async () => ({ success: false })) }));
vi.mock("../api/readState", () => ({
  markRead: vi.fn(async () => ({ success: true })),
  getUnreadCounts: vi.fn(async () => ({ success: false })),
  markAllRead: vi.fn(async () => ({ success: true })),
  markMentionSeen: vi.fn(async () => ({ success: true })),
}));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));

import { useE2EEStore } from "./e2eeStore";
import { useMessageStore } from "./messageStore";
import { useDMStore } from "./dmStore";
import { useUIStore } from "./uiStore";
import { useServerStore } from "./serverStore";
import { decryptDMMessages } from "../crypto/dmEncryption";
import * as signalProtocol from "../crypto/signalProtocol";
import * as dmApi from "../api/dm";
import * as messageApi from "../api/messages";
import type { DMMessage, Message } from "../types";

const DM = "dm-1";
const CHANNEL = "channel-1";
const MY_DEVICE = "device-1";

function plaintextDM(id: string, content: string): DMMessage {
  return {
    id,
    dm_channel_id: DM,
    user_id: "them",
    content,
    encryption_version: 0,
    created_at: "2026-07-29 10:00:00",
  } as DMMessage;
}

/**
 * A well-formed envelope addressed to THIS device. It has to be genuinely decryptable-looking:
 * with a malformed one, decryptDMMessage bails at the JSON parse and the "did we touch the
 * ratchet" assertion would pass whether or not the guard exists.
 */
function encryptedDM(id: string): DMMessage {
  const wireMessage = JSON.stringify({ type: 0, ciphertext: "x", header: {} });
  return {
    id,
    dm_channel_id: DM,
    user_id: "them",
    content: null,
    encryption_version: 1,
    ciphertext: JSON.stringify([{ recipient_device_id: MY_DEVICE, ciphertext: wireMessage }]),
    sender_device_id: "their-device",
    created_at: "2026-07-29 10:00:00",
  } as DMMessage;
}

function channelMessage(id: string, encrypted: boolean, channelId = CHANNEL): Message {
  return {
    id,
    channel_id: channelId,
    user_id: "them",
    content: encrypted ? null : "readable",
    encryption_version: encrypted ? 1 : 0,
    created_at: "2026-07-29 10:00:00",
  } as Message;
}

/**
 * The refill targets open tabs, not the selection — split view keeps several conversations
 * mounted and only one can be "selected". Tests therefore have to open tabs, not select channels.
 */
function openTabs(...tabs: { channelId: string; type: "text" | "dm" }[]) {
  useUIStore.setState({
    panels: {
      "panel-1": {
        id: "panel-1",
        activeTabId: "tab-0",
        tabs: tabs.map((t, i) => ({
          id: `tab-${i}`,
          channelId: t.channelId,
          type: t.type,
          label: t.channelId,
          serverInfo:
            t.type === "text"
              ? { serverId: "server-1", serverName: "s", serverIconUrl: null }
              : undefined,
        })),
      },
    },
    activePanelId: "panel-1",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useE2EEStore.setState({ initStatus: "uninitialized", localDeviceId: null, decryptionErrors: [] });
  // invalidateFetchCache also clears the module-level "already fetched" set, which would otherwise
  // leak between tests and make a fetch silently no-op.
  useMessageStore.getState().invalidateFetchCache();
  useDMStore.getState().invalidateFetchCache();
  useDMStore.setState({ selectedDMId: null });
  useUIStore.setState({ panels: {}, activePanelId: "panel-1" });
  // refillAfterKeysReady refetches through messageStore.fetchMessages, which resolves the server
  // from here when the caller passes none — same as setupNewDevice always has.
  useServerStore.setState({ activeServerId: "server-1" });
});

describe("DM fetch while E2EE is not ready", () => {
  it("should render a plaintext conversation even when init ended in error", async () => {
    useE2EEStore.setState({ initStatus: "error" });
    vi.mocked(dmApi.getDMMessages).mockResolvedValue({
      success: true,
      data: { messages: [plaintextDM("m1", "hello")], has_more: false },
    } as never);

    await useDMStore.getState().fetchMessages(DM);

    const held = useDMStore.getState().messagesByChannel[DM];
    expect(held).toHaveLength(1);
    expect(held[0].content).toBe("hello");
  });

  it("should leave a held cache alone when a resync page cannot be read yet", async () => {
    useE2EEStore.setState({ initStatus: "initializing" });
    const alreadyHeld = plaintextDM("held", "from before");
    useDMStore.setState({ messagesByChannel: { [DM]: [alreadyHeld] } });

    vi.mocked(dmApi.getDMMessages).mockResolvedValue({
      success: true,
      data: { messages: [encryptedDM("m2")], has_more: false },
    } as never);

    await useDMStore.getState().resyncChannel(DM);

    // Folding placeholders in would bury readable history behind them, and resync has no
    // invalidate step to undo it afterwards.
    expect(useDMStore.getState().messagesByChannel[DM]).toEqual([alreadyHeld]);
  });

  it("should still resync a plaintext page while init is running", async () => {
    useE2EEStore.setState({ initStatus: "initializing" });
    useDMStore.setState({ messagesByChannel: { [DM]: [] } });

    vi.mocked(dmApi.getDMMessages).mockResolvedValue({
      success: true,
      data: { messages: [plaintextDM("m3", "arrived")], has_more: false },
    } as never);

    await useDMStore.getState().resyncChannel(DM);

    expect(useDMStore.getState().messagesByChannel[DM]).toHaveLength(1);
  });
});

describe("decryptDMMessages before the keys exist", () => {
  it("should return placeholders without touching the ratchet", async () => {
    // localDeviceId set, envelope addressed to it: everything downstream is in place, so the only
    // thing standing between this call and signalProtocol.decryptMessage is the guard.
    useE2EEStore.setState({ initStatus: "initializing", localDeviceId: MY_DEVICE });

    const out = await decryptDMMessages([encryptedDM("e1"), plaintextDM("p1", "plain")]);

    expect(out[0].content).toBeNull();
    expect(out[1].content).toBe("plain");
    // decryptMessage runs processPreKeyMessage first, which writes session and trusted-identity
    // records — an attempt before the keys load is not a harmless no-op.
    expect(signalProtocol.decryptMessage).not.toHaveBeenCalled();
    expect(useE2EEStore.getState().decryptionErrors).toHaveLength(0);
  });
});

describe("refill once the keys are ready", () => {
  it("should refill content that was cached while the keys were still loading", async () => {
    useMessageStore.setState({ messagesByChannel: { [CHANNEL]: [channelMessage("c1", true)] } });
    openTabs({ channelId: CHANNEL, type: "text" });

    await useE2EEStore.getState().initialize("user-1");

    expect(useE2EEStore.getState().initStatus).toBe("ready");
    expect(useMessageStore.getState().messagesByChannel[CHANNEL]).toBeUndefined();
    expect(messageApi.getMessages).toHaveBeenCalled();
  });

  /**
   * Split view keeps several conversations mounted, and a mounted view whose channelId did not
   * change has no effect left to re-run. Refilling only the "selected" one left the other panel
   * blank with nothing to correct it.
   */
  it("should refill every open conversation, not only the one in front", async () => {
    const OTHER = "channel-2";
    useMessageStore.setState({
      messagesByChannel: {
        [CHANNEL]: [channelMessage("c1", true)],
        [OTHER]: [channelMessage("c2", true, OTHER)],
      },
    });
    openTabs({ channelId: CHANNEL, type: "text" }, { channelId: OTHER, type: "text" });

    await useE2EEStore.getState().initialize("user-1");

    const refetched = vi.mocked(messageApi.getMessages).mock.calls.map((c) => c[1]);
    expect(refetched).toContain(CHANNEL);
    expect(refetched).toContain(OTHER);
  });

  it("should leave a cache that was never gated untouched", async () => {
    const healthy = channelMessage("c2", false);
    useMessageStore.setState({ messagesByChannel: { [CHANNEL]: [healthy] } });
    openTabs({ channelId: CHANNEL, type: "text" });

    await useE2EEStore.getState().initialize("user-1");

    expect(useE2EEStore.getState().initStatus).toBe("ready");
    // The ordinary launch reaches this path every single time. Wiping here would throw away
    // loaded history and scroll position on every start.
    expect(useMessageStore.getState().messagesByChannel[CHANNEL]).toEqual([healthy]);
    expect(messageApi.getMessages).not.toHaveBeenCalled();
  });

  it("should discard a fetch that was already in flight when the keys arrived", async () => {
    // Left "uninitialized" on purpose — initialize() returns early on "initializing", so setting
    // that here would skip the refill entirely and the test would prove nothing.
    useMessageStore.setState({ messagesByChannel: { "other": [channelMessage("gated", true, "other")] } });
    openTabs({ channelId: "other", type: "text" });

    // A fetch for a second channel is mid-flight when init lands. Its page was decrypted before
    // the keys existed, so letting it write would put the placeholders straight back.
    let releaseFetch: (v: unknown) => void = () => {};
    vi.mocked(messageApi.getMessages).mockImplementationOnce(
      () => new Promise((resolve) => { releaseFetch = resolve; }) as never
    );
    const inFlight = useMessageStore.getState().fetchMessages(CHANNEL, "server-1");

    await useE2EEStore.getState().initialize("user-1");

    releaseFetch({ success: true, data: { messages: [channelMessage("stale", true)], has_more: false } });
    await inFlight;

    expect(useMessageStore.getState().messagesByChannel[CHANNEL]).toBeUndefined();
  });

  /**
   * The reconnect resync and the refill can be in flight at the same time. mergeLatestPage lets
   * the incoming page win on id, so a resync page decrypted under the old keys would overwrite
   * what the refill just fetched — and resync marks the channel fetched, so nothing corrects it.
   */
  it("should discard a resync whose page predates the keys", async () => {
    useMessageStore.setState({ messagesByChannel: { [CHANNEL]: [channelMessage("gated", true)] } });
    openTabs({ channelId: CHANNEL, type: "text" });

    let releaseResync: (v: unknown) => void = () => {};
    vi.mocked(messageApi.getMessages).mockImplementationOnce(
      () => new Promise((resolve) => { releaseResync = resolve; }) as never
    );
    const resyncing = useMessageStore
      .getState()
      .resyncChannel(CHANNEL, "server-1", { markRead: false });

    // Keys land while the resync is still waiting on the server.
    await useE2EEStore.getState().initialize("user-1");

    releaseResync({
      success: true,
      data: { messages: [channelMessage("stale", true)], has_more: false },
    });
    await resyncing;

    const held = useMessageStore.getState().messagesByChannel[CHANNEL];
    expect(held?.some((m) => m.id === "stale")).not.toBe(true);
  });

  /**
   * Refill fans out over every open tab while a MessageList may be mounting for one of them.
   * `fetchedChannels` cannot dedupe that: it is only set once the response is decrypted, so both
   * callers pass the guard and repeat the whole request.
   */
  it("should not fetch the same channel twice when two callers overlap", async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(messageApi.getMessages).mockImplementationOnce(
      () => new Promise((resolve) => { release = resolve; }) as never
    );

    const first = useMessageStore.getState().fetchMessages(CHANNEL, "server-1");
    const second = useMessageStore.getState().fetchMessages(CHANNEL, "server-1");

    release({ success: true, data: { messages: [], has_more: false } });
    await Promise.all([first, second]);

    expect(messageApi.getMessages).toHaveBeenCalledTimes(1);
  });

  it("should refill a gated DM as well as the channel", async () => {
    useDMStore.setState({ messagesByChannel: { [DM]: [encryptedDM("d1")] } });
    openTabs({ channelId: DM, type: "dm" });
    vi.mocked(dmApi.getDMMessages).mockResolvedValue({
      success: true,
      data: { messages: [plaintextDM("d2", "readable now")], has_more: false },
    } as never);

    await useE2EEStore.getState().initialize("user-1");

    expect(dmApi.getDMMessages).toHaveBeenCalledWith(DM, undefined, 50);
  });
});
