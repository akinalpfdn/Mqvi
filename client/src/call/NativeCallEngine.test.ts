/**
 * The native engine's recovery. Same machine as the web engine, driven by connection-state
 * events from the plugin instead of an RTCPeerConnection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { plugin, listeners, fetchIceServersForRecovery, fetchIceServers } = vi.hoisted(() => {
  const listeners: Record<string, (data: never) => void> = {};
  return {
    listeners,
    fetchIceServers: vi.fn(),
    fetchIceServersForRecovery: vi.fn(),
    plugin: {
      start: vi.fn(async () => {}),
      acceptRemoteOffer: vi.fn(async () => {}),
      acceptRemoteAnswer: vi.fn(async () => {}),
      addIceCandidate: vi.fn(async () => {}),
      setMicEnabled: vi.fn(async () => {}),
      setIceServers: vi.fn(async () => {}),
      restartIce: vi.fn(async () => {}),
      closeCall: vi.fn(async () => {}),
      addListener: vi.fn(async (event: string, cb: (data: never) => void) => {
        listeners[event] = cb;
        return { remove: vi.fn() };
      }),
    },
  };
});

vi.mock("../native/nativeP2PCall", () => ({ NativeP2PCall: plugin }));
vi.mock("../api/calls", () => ({ fetchIceServers, fetchIceServersForRecovery }));

import { NativeCallEngine } from "./NativeCallEngine";
import type { CallEngineEvents } from "./CallMediaEngine";

const REFRESHED = [{ urls: "turn:refreshed" }];

function events() {
  return {
    onLocalDescription: vi.fn(),
    onIceCandidate: vi.fn(),
    onRemoteStream: vi.fn(),
    onRemoteVideo: vi.fn(),
    onLocalStream: vi.fn(),
    onIceRestartNeeded: vi.fn(),
    onScreenShareEnded: vi.fn(),
    onConnectionLost: vi.fn(),
  } satisfies CallEngineEvents;
}

async function engineFor(isCaller: boolean) {
  const ev = events();
  const engine = new NativeCallEngine(ev);
  await engine.start({ callId: "c1", callType: "voice", isCaller });
  return { engine, ev };
}

function connectionState(state: string) {
  listeners.connectionState?.({ state } as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
  fetchIceServers.mockResolvedValue([]);
  fetchIceServersForRecovery.mockResolvedValue(REFRESHED);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("native engine recovery", () => {
  it("should refresh credentials and restart ICE when the caller's connection fails", async () => {
    await engineFor(true);
    connectionState("failed");
    await vi.advanceTimersByTimeAsync(0);

    expect(plugin.setIceServers).toHaveBeenCalledWith({
      iceServers: [{ urls: "turn:refreshed", username: undefined, credential: undefined }],
    });
    expect(plugin.restartIce).toHaveBeenCalledTimes(1);
  });

  it("should ask the peer instead of restarting when this side is the receiver", async () => {
    const { ev } = await engineFor(false);
    connectionState("failed");
    await vi.advanceTimersByTimeAsync(0);

    expect(plugin.restartIce).not.toHaveBeenCalled();
    expect(ev.onIceRestartNeeded).toHaveBeenCalledTimes(1);
  });

  it("should end the call after the attempt cap", async () => {
    const { ev } = await engineFor(true);
    connectionState("failed");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(7000);
    expect(plugin.restartIce).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7000);
    expect(ev.onConnectionLost).toHaveBeenCalledTimes(1);
  });

  it("should treat a brief disconnect as a blip and recover without restarting", async () => {
    await engineFor(true);
    connectionState("disconnected");
    await vi.advanceTimersByTimeAsync(4000);
    connectionState("connected");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(plugin.restartIce).not.toHaveBeenCalled();
  });

  it("should restart once a disconnect outlives the grace window", async () => {
    await engineFor(true);
    connectionState("disconnected");
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(0);

    expect(plugin.restartIce).toHaveBeenCalledTimes(1);
  });

  it("should stop touching the call once closed", async () => {
    const { engine, ev } = await engineFor(true);
    engine.close();
    connectionState("failed");
    await vi.advanceTimersByTimeAsync(20_000);

    expect(plugin.restartIce).not.toHaveBeenCalled();
    expect(ev.onConnectionLost).not.toHaveBeenCalled();
  });

  it("should queue candidates until a remote description exists", async () => {
    const { engine } = await engineFor(true);
    await engine.addIceCandidate({ candidate: "cand-1", sdpMid: "0", sdpMLineIndex: 0 });
    expect(plugin.addIceCandidate).not.toHaveBeenCalled();

    await engine.acceptRemoteAnswer("answer-sdp");
    expect(plugin.addIceCandidate).toHaveBeenCalledWith({
      candidate: "cand-1",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
  });
});
