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
      start: vi.fn(async () => ({ video: false })),
      acceptRemoteOffer: vi.fn(async () => {}),
      acceptRemoteAnswer: vi.fn(async () => {}),
      addIceCandidate: vi.fn(async () => {}),
      setMicEnabled: vi.fn(async () => {}),
      setRemoteVolume: vi.fn(async () => {}),
      setIceServers: vi.fn(async () => {}),
      switchCamera: vi.fn(async (): Promise<{ facing: "front" | "back" }> => ({ facing: "front" })),
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
const { voiceReleased } = vi.hoisted(() => ({
  voiceReleased: { current: Promise.resolve() as Promise<void> },
}));
vi.mock("../utils/nativePlugins", () => ({ nativeVoiceReleased: () => voiceReleased.current }));
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
    onLocalVideo: vi.fn(),
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

function connectionState(state: string, callId = "c1") {
  listeners.connectionState?.({ callId, state } as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
  fetchIceServers.mockResolvedValue([]);
  fetchIceServersForRecovery.mockResolvedValue(REFRESHED);
  voiceReleased.current = Promise.resolve();
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

  it("should run one recovery, not two, when the connection flaps during a credential fetch", async () => {
    const pending: ((servers: RTCIceServer[]) => void)[] = [];
    fetchIceServersForRecovery.mockImplementation(
      () => new Promise<RTCIceServer[]>((resolve) => pending.push(resolve)),
    );
    await engineFor(true);

    connectionState("failed"); // run 1 starts fetching credentials
    connectionState("connected"); // recovered on its own — run 1 is over
    connectionState("failed"); // run 2 starts, while run 1's fetch is still out
    await vi.advanceTimersByTimeAsync(0);
    pending.forEach((resolve) => resolve(REFRESHED));
    await vi.advanceTimersByTimeAsync(0);

    // Only the current run restarts; the stale one sees it is over and stays quiet.
    expect(plugin.restartIce).toHaveBeenCalledTimes(1);

    // One retry timer, so one more attempt after the window — not two.
    await vi.advanceTimersByTimeAsync(7000);
    pending.forEach((resolve) => resolve(REFRESHED));
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.restartIce).toHaveBeenCalledTimes(2);
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

describe("native engine volume", () => {
  it("should pass the peer's volume to the plugin, which plays the audio", async () => {
    const { engine } = await engineFor(true);
    engine.setRemoteVolume(150);
    expect(plugin.setRemoteVolume).toHaveBeenCalledWith({ volume: 150 });
  });
});

describe("native engine camera", () => {
  it("should report the camera the native side ended up on", async () => {
    plugin.switchCamera.mockResolvedValue({ facing: "back" });
    const { engine } = await engineFor(true);

    expect(await engine.switchCamera()).toBe("back");
  });

  it("should report nothing when the native side cannot switch", async () => {
    plugin.switchCamera.mockRejectedValue(new Error("no second camera"));
    const { engine } = await engineFor(true);

    expect(await engine.switchCamera()).toBeNull();
  });

  it("should not touch the camera once the call is closed", async () => {
    const { engine } = await engineFor(true);
    engine.close();

    expect(await engine.switchCamera()).toBeNull();
    expect(plugin.switchCamera).not.toHaveBeenCalled();
  });
});

/**
 * start() sits on the microphone and camera prompts. On a fresh install that is exactly when
 * the caller's offer arrives, and an offer is never re-sent: dropping one leaves the call
 * connected with no media in either direction for its whole duration.
 */
describe("signalling that arrives while start is still waiting on permissions", () => {
  it("should apply an offer that arrives before start finishes, not drop it", async () => {
    let letStartFinish!: () => void;
    plugin.start.mockImplementationOnce(
      () =>
        new Promise<{ video: boolean }>((resolve) => {
          letStartFinish = () => resolve({ video: true });
        }),
    );

    const engine = new NativeCallEngine(events());
    const starting = engine.start({ callId: "c1", callType: "video", isCaller: false });
    await vi.advanceTimersByTimeAsync(0);

    // The offer lands while the permission prompts are still up.
    const offered = engine.acceptRemoteOffer("v=0");
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.acceptRemoteOffer).not.toHaveBeenCalled();

    letStartFinish();
    await starting;
    await offered;
    expect(plugin.acceptRemoteOffer).toHaveBeenCalledWith({ sdp: "v=0" });
  });

  it("should apply an answer that arrives before start finishes", async () => {
    let letStartFinish!: () => void;
    plugin.start.mockImplementationOnce(
      () =>
        new Promise<{ video: boolean }>((resolve) => {
          letStartFinish = () => resolve({ video: true });
        }),
    );

    const engine = new NativeCallEngine(events());
    const starting = engine.start({ callId: "c1", callType: "video", isCaller: true });
    await vi.advanceTimersByTimeAsync(0);

    const answered = engine.acceptRemoteAnswer("v=0");
    letStartFinish();
    await starting;
    await answered;
    expect(plugin.acceptRemoteAnswer).toHaveBeenCalledWith({ sdp: "v=0" });
  });
});

/**
 * The plugin's listeners outlive any one call, and a closed connection can still emit. An event
 * from another call that reached this one forwarded a stale offer to the new peer.
 */
describe("events that belong to another call", () => {
  it("should drop a local description for a different call", async () => {
    const { ev } = await engineFor(true);
    listeners.localDescription?.({ callId: "old-call", type: "offer", sdp: "stale" } as never);
    expect(ev.onLocalDescription).not.toHaveBeenCalled();

    listeners.localDescription?.({ callId: "c1", type: "offer", sdp: "fresh" } as never);
    expect(ev.onLocalDescription).toHaveBeenCalledWith({ type: "offer", sdp: "fresh" });
  });

  it("should drop an ICE candidate for a different call", async () => {
    const { ev } = await engineFor(true);
    listeners.iceCandidate?.({ callId: "old-call", candidate: "c", sdpMid: "0", sdpMLineIndex: 0 } as never);
    expect(ev.onIceCandidate).not.toHaveBeenCalled();
  });

  it("should not drive recovery from another call's connection state", async () => {
    await engineFor(true);
    connectionState("failed", "old-call");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchIceServersForRecovery).not.toHaveBeenCalled();
  });
});

describe("start is idempotent and safe to cancel", () => {
  it("should start the plugin once when start is called twice", async () => {
    const engine = new NativeCallEngine(events());
    await Promise.all([
      engine.start({ callId: "c1", callType: "voice", isCaller: false }),
      engine.start({ callId: "c1", callType: "voice", isCaller: false }),
    ]);
    expect(plugin.start).toHaveBeenCalledTimes(1);
    // Four events, one listener each — a second begin would have made it eight.
    expect(plugin.addListener).toHaveBeenCalledTimes(4);
  });

  it("should remove listeners that finish attaching after close", async () => {
    const removals: ReturnType<typeof vi.fn>[] = [];
    plugin.addListener.mockImplementation(async (event: string, cb: (data: never) => void) => {
      listeners[event] = cb;
      const remove = vi.fn();
      removals.push(remove);
      return { remove };
    });

    const engine = new NativeCallEngine(events());
    const starting = engine.start({ callId: "c1", callType: "voice", isCaller: false });
    engine.close();
    await starting;

    // Whatever attached, nothing stays attached.
    for (const remove of removals) expect(remove).toHaveBeenCalled();
    expect(plugin.start).not.toHaveBeenCalled();
  });

  it("should treat a plugin start cancelled by close as a clean stop, not a failure", async () => {
    let failStart!: (err: Error) => void;
    plugin.start.mockImplementationOnce(
      () =>
        new Promise<{ video: boolean }>((_, reject) => {
          failStart = reject;
        }),
    );

    const ev = events();
    const engine = new NativeCallEngine(ev);
    const starting = engine.start({ callId: "c1", callType: "video", isCaller: false });
    await vi.advanceTimersByTimeAsync(0);

    // Hung up while the permission prompt was on screen; the plugin declines to build the call.
    engine.close();
    failStart(new Error("cancelled"));

    await expect(starting).resolves.toBeUndefined();
    expect(ev.onLocalVideo).not.toHaveBeenCalled();
  });
});

/**
 * Starting a call leaves the voice channel, and LiveKit lets go of the shared audio session only
 * after its disconnect has returned. Taking the session before that let LiveKit reset it under
 * the call that had just started.
 */
describe("native engine and channel voice", () => {
  it("should not take the audio session until channel voice has let go of it", async () => {
    let release!: () => void;
    voiceReleased.current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const engine = new NativeCallEngine(events());
    const starting = engine.start({ callId: "c1", callType: "voice", isCaller: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(plugin.start).not.toHaveBeenCalled();

    release();
    await starting;
    expect(plugin.start).toHaveBeenCalledTimes(1);
  });

  it("should start anyway once the wait runs out, rather than never", async () => {
    voiceReleased.current = new Promise<void>(() => {}); // a disconnect that never settles
    const engine = new NativeCallEngine(events());
    const starting = engine.start({ callId: "c1", callType: "voice", isCaller: true });

    await vi.advanceTimersByTimeAsync(3_000);
    await starting;
    expect(plugin.start).toHaveBeenCalledTimes(1);
  });

  it("should hand a mute made before start to the plugin, which keeps it for the track", () => {
    const engine = new NativeCallEngine(events());
    engine.setMicEnabled(false);
    expect(plugin.setMicEnabled).toHaveBeenCalledWith({ enabled: false });
  });
});
