/** The native engine: recovery from plugin connection states, signalling order, events, lifecycle. */
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
      resendPendingOffer: vi.fn(async () => ({ resent: false })),
      currentCall: vi.fn(async (): Promise<{ callId: string | null }> => ({ callId: "c1" })),
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
import { INSTANCE_ID } from "../utils/deviceId";
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
    connectionState("connected");
    connectionState("failed");
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(7000);
    expect(plugin.restartIce).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7000);
    expect(ev.onConnectionLost).toHaveBeenCalledTimes(1);
  });

  // A peer answering from the lock screen may sit on a permission prompt; the cap's 14 s must
  // not undercut the first-connect window that exists for exactly that.
  it("should leave a call that never connected to the first-connect window", async () => {
    const { ev } = await engineFor(true);
    connectionState("failed");
    await vi.advanceTimersByTimeAsync(14_000);
    expect(plugin.restartIce).toHaveBeenCalledTimes(2);
    expect(ev.onConnectionLost).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
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

describe("native engine start", () => {
  // A reload hangs the call up in the name of the page that started it.
  it("should tell the plugin which page instance runs the call", async () => {
    await engineFor(true);
    expect(plugin.start).toHaveBeenCalledWith(expect.objectContaining({ instanceId: INSTANCE_ID }));
  });
});

describe("native engine taking over a call a previous page ran", () => {
  // The page died under memory pressure; the call's media never stopped and must not restart.
  it("should attach to the running call without starting anything", async () => {
    const ev = events();
    const engine = new NativeCallEngine(ev);

    await engine.adopt({ callId: "c1", isCaller: true, state: "connected" });
    listeners.localDescription?.({ callId: "c1", type: "offer", sdp: "o" } as never);

    expect(plugin.start).not.toHaveBeenCalled();
    expect(ev.onLocalDescription).toHaveBeenCalledWith({ type: "offer", sdp: "o" });
  });

  it("should recover a taken-over call whose connection is down", async () => {
    const ev = events();
    const engine = new NativeCallEngine(ev);

    await engine.adopt({ callId: "c1", isCaller: true, state: "failed" });
    await vi.advanceTimersByTimeAsync(0);

    expect(plugin.restartIce).toHaveBeenCalledTimes(1);
  });
});

describe("native engine after a socket replacement", () => {
  it("should re-send an unanswered offer and leave it at that", async () => {
    const { engine } = await engineFor(true);
    plugin.resendPendingOffer.mockResolvedValueOnce({ resent: true });
    engine.resync();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.resendPendingOffer).toHaveBeenCalledTimes(1);
    expect(plugin.restartIce).not.toHaveBeenCalled();
  });

  it("should recover a call that has not connected when there is no offer to re-send", async () => {
    const { engine, ev } = await engineFor(false);
    engine.resync();
    await vi.advanceTimersByTimeAsync(0);
    expect(ev.onIceRestartNeeded).toHaveBeenCalledTimes(1); // the receiver asks for a new offer
  });

  it("should leave a connected call alone", async () => {
    const { engine } = await engineFor(true);
    connectionState("connected");
    engine.resync();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.restartIce).not.toHaveBeenCalled();
  });

  // Hung up on the lock screen, or ended natively because the connection died, while the page
  // was suspended: the page must not wake up to a call that is no longer there.
  it("should end the call when the native side no longer runs it", async () => {
    const { engine, ev } = await engineFor(true);
    connectionState("connected");
    plugin.currentCall.mockResolvedValueOnce({ callId: null });

    engine.resync();
    await vi.advanceTimersByTimeAsync(0);

    expect(ev.onConnectionLost).toHaveBeenCalledTimes(1);
    expect(plugin.resendPendingOffer).not.toHaveBeenCalled();
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

/** An offer landing while start waits on permission prompts is applied, not dropped. */
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

/** Events from another call are dropped: the plugin's listeners outlive any one call. */
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
    // One listener per event — a second begin would have doubled them.
    expect(plugin.addListener).toHaveBeenCalledTimes(5);
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

/** The call takes the audio session only after channel voice lets go of it. */
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

describe("a call that never connects", () => {
  it("should end once the first-connect window passes", async () => {
    const { ev } = await engineFor(true);
    connectionState("connecting");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ev.onConnectionLost).toHaveBeenCalledTimes(1);
  });

  it("should leave a call alone once it has connected", async () => {
    const { ev } = await engineFor(true);
    connectionState("connected");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ev.onConnectionLost).not.toHaveBeenCalled();
  });

  it("should end a call whose start never gets past a permission prompt", async () => {
    plugin.start.mockImplementationOnce(() => new Promise<{ video: boolean }>(() => {}));
    const ev = events();
    const engine = new NativeCallEngine(ev);
    void engine.start({ callId: "c1", callType: "voice", isCaller: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ev.onConnectionLost).toHaveBeenCalledTimes(1);
  });
});

describe("native engine offers", () => {
  it("should apply one offer only after the previous one has been answered", async () => {
    const { engine } = await engineFor(false);
    const order: string[] = [];
    let finishFirst!: () => void;
    plugin.acceptRemoteOffer
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            order.push("start:1");
            finishFirst = () => {
              order.push("end:1");
              resolve();
            };
          }),
      )
      .mockImplementationOnce(async () => {
        order.push("start:2");
      });

    const first = engine.acceptRemoteOffer("offer-1");
    const second = engine.acceptRemoteOffer("offer-2");
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["start:1"]);

    finishFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["start:1", "end:1", "start:2"]);
  });
});

describe("native engine camera failure", () => {
  it("should report the camera off when the plugin says it failed to start", async () => {
    const { ev } = await engineFor(true);
    listeners.localVideo?.({ callId: "c1", available: false } as never);
    expect(ev.onLocalVideo).toHaveBeenLastCalledWith(false);
  });
});
