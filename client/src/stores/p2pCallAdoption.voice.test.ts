import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdoptableCall } from "../native/nativeP2PCall";

const { discard, connect } = vi.hoisted(() => ({ discard: vi.fn(), connect: vi.fn(async () => true) }));
vi.mock("../native/nativeP2PCall", () => ({ NativeP2PCall: { discardOrphanedCall: discard } }));
vi.mock("../native/p2pCall", () => ({ dismissIncomingCallUI: vi.fn() }));
vi.mock("../api/voice", () => ({ getVoiceToken: vi.fn(async () => ({ success: true, data: { token: "test", url: "wss://example.invalid" } })) }));
vi.mock("../api/client", () => ({ ensureFreshToken: vi.fn(async () => true) }));
vi.mock("../utils/devicePermissions", () => ({ ensureMicPermission: vi.fn(async () => true) }));
vi.mock("../utils/nativePlugins", () => ({
  useNativeVoice: () => true, nativeVoiceConnect: connect, stopNativeVoiceSession: vi.fn(),
  startVoiceCallService: vi.fn(), stopVoiceCallService: vi.fn(),
}));
vi.mock("./serverStore", () => ({ useServerStore: { getState: () => ({ activeServerId: "server" }) } }));
vi.mock("./preferencesStore", () => ({ usePreferencesStore: { getState: () => ({ set: vi.fn() }) } }));
vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));

import { useP2PCallStore } from "./p2pCallStore";
import { useVoiceStore } from "./voiceStore";

const candidate: AdoptableCall = {
  callId: "old-call", instanceId: "old-page", isCaller: false, state: "connected",
  micEnabled: true, videoEnabled: false, facing: "front", remoteVideo: false, volume: 100, inCallKit: true,
};
const send = vi.fn();
const adopted = { id: candidate.callId, status: "active" as const, caller_id: "them", receiver_id: "me",
  caller_username: "them", caller_display_name: null, caller_avatar: null, receiver_username: "me",
  receiver_display_name: null, receiver_avatar: null, call_type: "voice" as const, created_at: "" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  discard.mockReset().mockResolvedValue({ discarded: true });
  useP2PCallStore.setState({ activeCall: null, engine: null, _sessionId: null, _adoptCandidate: null,
    _adoptTimer: null, _sendWS: send, _previousPageCallChecked: Promise.resolve() });
  useVoiceStore.setState({ currentVoiceChannelId: null, currentVoiceServerId: null, _joinGeneration: 0 });
});
afterEach(() => { vi.useRealTimers(); });

describe("channel voice during native call adoption", () => {
  it("waits for native teardown, ignores late adoption and does not repeat teardown at the old deadline", async () => {
    let release!: () => void;
    discard.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    useP2PCallStore.getState().holdAdoptableCall(candidate);
    const joining = useVoiceStore.getState().joinVoiceChannel("channel");
    await vi.advanceTimersByTimeAsync(0);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
    useP2PCallStore.getState().handleCallAdopted(adopted);
    expect(useP2PCallStore.getState().activeCall).toBeNull();
    release();
    await joining;
    expect(connect).toHaveBeenCalledTimes(1);
    expect(useP2PCallStore.getState()._adoptCandidate).toBeNull();
    expect(send).toHaveBeenCalledWith("p2p_call_end", { call_id: "old-call", instance_id: "old-page" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it("blocks voice when discard fails and retries without accepting a delayed adoption", async () => {
    useP2PCallStore.getState().holdAdoptableCall(candidate);
    discard.mockRejectedValueOnce(new Error("bridge unavailable"));
    expect(await useVoiceStore.getState().joinVoiceChannel("channel")).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    useP2PCallStore.getState().handleCallAdopted(adopted);
    expect(useP2PCallStore.getState().activeCall).toBeNull();
    await useVoiceStore.getState().joinVoiceChannel("channel");
    expect(discard).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("waits for the boot check and cancels a superseded join during teardown", async () => {
    let boot!: () => void;
    let release!: () => void;
    useP2PCallStore.setState({ _previousPageCallChecked: new Promise<void>((resolve) => { boot = resolve; }) });
    discard.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = useVoiceStore.getState().joinVoiceChannel("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).not.toHaveBeenCalled();
    useP2PCallStore.getState().holdAdoptableCall(candidate);
    boot();
    await vi.advanceTimersByTimeAsync(0);
    const second = useVoiceStore.getState().joinVoiceChannel("second");
    await vi.advanceTimersByTimeAsync(0);
    expect(discard).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toBeNull();
    await second;
    expect(connect).toHaveBeenCalledTimes(1);
    expect(useVoiceStore.getState().currentVoiceChannelId).toBe("second");
  });
});
