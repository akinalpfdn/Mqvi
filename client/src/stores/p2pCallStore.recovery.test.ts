/** The web engine's bounded ICE-restart recovery. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fetchIceServers, fetchIceServersForRecovery } = vi.hoisted(() => ({
  fetchIceServers: vi.fn(),
  fetchIceServersForRecovery: vi.fn(),
}));
vi.mock("../api/calls", () => ({ fetchIceServers, fetchIceServersForRecovery }));

import { WebCallEngine } from "../call/WebCallEngine";
import type { CallEngineEvents } from "../call/CallMediaEngine";

const REFRESH_SERVERS = [{ urls: "stun:refreshed" }];

// Minimal fake RTCPeerConnection — only what the engine touches.
function fakePC() {
  return {
    connectionState: "new" as RTCPeerConnectionState,
    signalingState: "stable" as RTCSignalingState,
    remoteDescription: null as unknown,
    onicecandidate: null as ((e: unknown) => void) | null,
    ontrack: null as ((e: unknown) => void) | null,
    onconnectionstatechange: null as (() => void) | null,
    onnegotiationneeded: null as (() => void) | null,
    restartIce: vi.fn(),
    setConfiguration: vi.fn(),
    getConfiguration: () => ({}),
    close: vi.fn(),
    addTrack: vi.fn(),
    getSenders: () => [],
    getReceivers: () => [],
    setRemoteDescription: vi.fn(async () => {}),
    setLocalDescription: vi.fn(async () => {}),
    createAnswer: vi.fn(async () => ({ type: "answer", sdp: "answer-sdp" })),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" })),
    addIceCandidate: vi.fn(async () => {}),
  };
}

const emptyStream = {
  getTracks: () => [],
  getAudioTracks: () => [],
  getVideoTracks: () => [],
} as unknown as MediaStream;

let pc: ReturnType<typeof fakePC>;
const originalRTCPeerConnection = globalThis.RTCPeerConnection;
const originalSessionDescription = globalThis.RTCSessionDescription;

function events(): CallEngineEvents & { spies: Record<string, ReturnType<typeof vi.fn>> } {
  const spies = {
    onLocalDescription: vi.fn(),
    onIceCandidate: vi.fn(),
    onRemoteStream: vi.fn(),
    onLocalStream: vi.fn(),
    onRemoteVideo: vi.fn(),
    onLocalVideo: vi.fn(),
    onIceRestartNeeded: vi.fn(),
    onScreenShareEnded: vi.fn(),
    onConnectionLost: vi.fn(),
  };
  return { ...spies, spies } as never;
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchIceServers.mockReset().mockResolvedValue([]);
  fetchIceServersForRecovery.mockReset().mockResolvedValue(REFRESH_SERVERS);
  pc = fakePC();
  // A plain function so `new RTCPeerConnection()` is valid; returning an object makes the
  // constructor yield our fake.
  globalThis.RTCPeerConnection = function FakeRTCPeerConnection() {
    return pc;
  } as unknown as typeof RTCPeerConnection;
  globalThis.RTCSessionDescription = function FakeDescription(init: unknown) {
    return init;
  } as unknown as typeof RTCSessionDescription;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: { getUserMedia: vi.fn(async () => emptyStream) },
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.RTCPeerConnection = originalRTCPeerConnection;
  globalThis.RTCSessionDescription = originalSessionDescription;
});

/** Builds an engine whose connection exists and is current. */
async function harness(isCaller: boolean) {
  const ev = events();
  const engine = new WebCallEngine(ev);
  await engine.start({ callId: "c1", callType: "voice", isCaller });
  if (!isCaller) {
    // The answerer builds its connection from the first offer.
    await engine.acceptRemoteOffer("remote-offer");
  }
  return { engine, ev, pc };
}

function fail() {
  pc.connectionState = "failed";
  pc.onconnectionstatechange?.();
}

describe("ICE-restart recovery", () => {
  it("caller refreshes credentials and restarts ICE on failure", async () => {
    await harness(true);
    fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.setConfiguration).toHaveBeenCalledWith({ iceServers: REFRESH_SERVERS });
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
  });

  it("receiver asks the peer to restart instead of calling restartIce", async () => {
    const { ev } = await harness(false);
    fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(ev.onIceRestartNeeded).toHaveBeenCalledTimes(1);
  });

  it("retries up to the cap, then reports the call lost", async () => {
    const { ev } = await harness(true);
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    fail();
    await vi.advanceTimersByTimeAsync(0); // attempt 1
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7000); // attempt 2
    expect(pc.restartIce).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7000); // cap reached
    expect(ev.onConnectionLost).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once reconnected", async () => {
    const { ev } = await harness(true);
    fail();
    await vi.advanceTimersByTimeAsync(0); // attempt 1
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(7000);
    expect(pc.restartIce).toHaveBeenCalledTimes(1); // no further attempts
    expect(ev.onConnectionLost).not.toHaveBeenCalled();
  });

  it("an incoming ice-restart request drives the caller's recovery", async () => {
    const { engine } = await harness(true);
    engine.restartIce();
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
  });

  // The peer came back on a new connection and never got our offer; a restart would wait on it.
  it("sends an unanswered offer again instead of restarting behind it", async () => {
    const { engine, ev } = await harness(true);
    pc.signalingState = "have-local-offer";
    (pc as { localDescription?: unknown }).localDescription = { type: "offer", sdp: "pending-offer" };
    engine.restartIce();
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(ev.onLocalDescription).toHaveBeenLastCalledWith({ type: "offer", sdp: "pending-offer" });
  });

  it("after a socket replacement, re-sends an offer that was never answered", async () => {
    const { engine, ev } = await harness(true);
    pc.signalingState = "have-local-offer";
    (pc as { localDescription?: unknown }).localDescription = { type: "offer", sdp: "lost-offer" };
    engine.resync();
    expect(ev.onLocalDescription).toHaveBeenLastCalledWith({ type: "offer", sdp: "lost-offer" });
    expect(pc.restartIce).not.toHaveBeenCalled();
  });

  it("after a socket replacement, the receiver asks for the offer it never got", async () => {
    const ev = events();
    const engine = new WebCallEngine(ev);
    await engine.start({ callId: "c1", callType: "voice", isCaller: false }); // no offer yet, no connection
    engine.resync();
    expect(ev.onIceRestartNeeded).toHaveBeenCalledTimes(1);
  });

  it("after a socket replacement, recovers a connection that is not up", async () => {
    const { engine } = await harness(true);
    engine.resync();
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.restartIce).toHaveBeenCalledTimes(1);
  });

  it("after a socket replacement, leaves a connected call alone", async () => {
    const { engine, ev } = await harness(true);
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    engine.resync();
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(ev.onLocalDescription).not.toHaveBeenCalledWith(expect.objectContaining({ sdp: "lost-offer" }));
  });

  it("the same request on the receiver asks the peer rather than restarting", async () => {
    const { engine, ev } = await harness(false);
    engine.restartIce();
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.restartIce).not.toHaveBeenCalled();
    expect(ev.onIceRestartNeeded).toHaveBeenCalledTimes(1);
  });

  it("a closed engine cannot trigger recovery", async () => {
    const { engine } = await harness(true);
    engine.close();
    fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.restartIce).not.toHaveBeenCalled();
  });

  it("keeps the existing config when the recovery fetch fails (no STUN downgrade)", async () => {
    fetchIceServersForRecovery.mockResolvedValue(null);
    await harness(true);
    fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.setConfiguration).not.toHaveBeenCalled(); // did not strip TURN
    expect(pc.restartIce).toHaveBeenCalledTimes(1); // still restarts with the existing config
  });

  it("does not restart if the connection recovers during the credential fetch", async () => {
    let resolveFetch: (v: RTCIceServer[] | null) => void = () => {};
    fetchIceServersForRecovery.mockReturnValue(
      new Promise<RTCIceServer[] | null>((r) => {
        resolveFetch = r;
      }),
    );
    await harness(true);
    fail(); // starts recovery, suspends on the pending fetch
    pc.connectionState = "connected"; // recovers on its own meanwhile
    pc.onconnectionstatechange?.();
    resolveFetch(REFRESH_SERVERS);
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.restartIce).not.toHaveBeenCalled();
  });
});

describe("a web call that never connects", () => {
  it("should end the call once the first-connect window passes, on either side", async () => {
    for (const isCaller of [true, false]) {
      const { ev } = await harness(isCaller);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ev.spies.onConnectionLost).toHaveBeenCalledTimes(1);
    }
  });

  it("should leave a connected call alone", async () => {
    const { ev } = await harness(true);
    pc.connectionState = "connected";
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ev.spies.onConnectionLost).not.toHaveBeenCalled();
  });
});

describe("a web receiver whose offer never comes", () => {
  it("should end the call, though it has no connection yet", async () => {
    const ev = events();
    const engine = new WebCallEngine(ev);
    await engine.start({ callId: "c1", callType: "voice", isCaller: false }); // no offer follows
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ev.spies.onConnectionLost).toHaveBeenCalledTimes(1);
    engine.close();
  });
});

// Both sides renegotiating at once (both turn the camera on). Without a tie-break each rolls back
// or rejects the other and neither change lands.
describe("offer collisions", () => {
  it("the caller keeps its own offer and ignores the peer's", async () => {
    const { engine } = await harness(true);
    pc.signalingState = "have-local-offer";
    pc.setRemoteDescription.mockClear();

    await engine.acceptRemoteOffer("their-offer");

    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });

  it("the receiver drops its own offer and answers the caller's", async () => {
    const { engine, ev } = await harness(false);
    pc.signalingState = "have-local-offer";
    pc.setLocalDescription.mockClear();

    await engine.acceptRemoteOffer("caller-offer");

    expect(pc.setLocalDescription).toHaveBeenNthCalledWith(1, { type: "rollback" });
    expect(pc.setRemoteDescription).toHaveBeenLastCalledWith({ type: "offer", sdp: "caller-offer" });
    expect(ev.onLocalDescription).toHaveBeenLastCalledWith({ type: "answer", sdp: "answer-sdp" });
  });
});
