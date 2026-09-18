/**
 * The receiver's side of the web engine. Offers can arrive back to back, and each one used to
 * build its own connection and ask for the microphone again; the extra connection was never
 * closed. Separately, one candidate the connection rejected aborted the answer entirely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fetchIceServers } = vi.hoisted(() => ({ fetchIceServers: vi.fn() }));
vi.mock("../api/calls", () => ({ fetchIceServers, fetchIceServersForRecovery: vi.fn() }));

import { WebCallEngine } from "./WebCallEngine";
import type { CallEngineEvents } from "./CallMediaEngine";

function fakePC() {
  return {
    connectionState: "new" as RTCPeerConnectionState,
    signalingState: "stable" as RTCSignalingState,
    remoteDescription: null as unknown,
    onicecandidate: null,
    ontrack: null,
    onconnectionstatechange: null,
    onnegotiationneeded: null,
    restartIce: vi.fn(),
    setConfiguration: vi.fn(),
    getConfiguration: () => ({}),
    close: vi.fn(),
    addTrack: vi.fn(),
    getSenders: () => [],
    getReceivers: () => [],
    setRemoteDescription: vi.fn(async function (this: { remoteDescription: unknown }, d: unknown) {
      this.remoteDescription = d;
    }),
    setLocalDescription: vi.fn(async () => {}),
    createAnswer: vi.fn(async () => ({ type: "answer", sdp: "answer-sdp" })),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer-sdp" })),
    addIceCandidate: vi.fn(async (_candidate: { candidate: string }) => {}),
  };
}

const emptyStream = {
  getTracks: () => [],
  getAudioTracks: () => [],
  getVideoTracks: () => [],
} as unknown as MediaStream;

const originals = {
  pc: globalThis.RTCPeerConnection,
  sd: globalThis.RTCSessionDescription,
  ice: globalThis.RTCIceCandidate,
};

let built: ReturnType<typeof fakePC>[];
let getUserMedia: ReturnType<typeof vi.fn>;

function events() {
  return {
    onLocalDescription: vi.fn(),
    onIceCandidate: vi.fn(),
    onRemoteStream: vi.fn(),
    onLocalStream: vi.fn(),
    onRemoteVideo: vi.fn(),
    onLocalVideo: vi.fn(),
    onIceRestartNeeded: vi.fn(),
    onScreenShareEnded: vi.fn(),
    onConnectionLost: vi.fn(),
  } satisfies CallEngineEvents;
}

beforeEach(() => {
  built = [];
  fetchIceServers.mockReset().mockResolvedValue([]);
  globalThis.RTCPeerConnection = function FakeRTCPeerConnection() {
    const pc = fakePC();
    built.push(pc);
    return pc;
  } as unknown as typeof RTCPeerConnection;
  globalThis.RTCSessionDescription = function FakeDescription(init: unknown) {
    return init;
  } as unknown as typeof RTCSessionDescription;
  globalThis.RTCIceCandidate = function FakeCandidate(init: unknown) {
    return init;
  } as unknown as typeof RTCIceCandidate;
  getUserMedia = vi.fn(async () => emptyStream);
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
});

afterEach(() => {
  globalThis.RTCPeerConnection = originals.pc;
  globalThis.RTCSessionDescription = originals.sd;
  globalThis.RTCIceCandidate = originals.ice;
});

async function receiver() {
  const ev = events();
  const engine = new WebCallEngine(ev);
  await engine.start({ callId: "c1", callType: "voice", isCaller: false });
  return { engine, ev };
}

describe("web engine receiving offers", () => {
  it("should build one connection and ask for the microphone once when two offers arrive together", async () => {
    const { engine, ev } = await receiver();

    await Promise.all([engine.acceptRemoteOffer("offer-1"), engine.acceptRemoteOffer("offer-2")]);

    expect(built).toHaveLength(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    // The second offer renegotiates the same connection and is answered by it.
    expect(built[0].setRemoteDescription).toHaveBeenCalledTimes(2);
    expect(ev.onLocalDescription).toHaveBeenCalledTimes(2);
  });

  it("should still answer when a queued candidate is rejected", async () => {
    const { engine, ev } = await receiver();
    await engine.addIceCandidate({ candidate: "bad", sdpMid: "0", sdpMLineIndex: 0 });
    await engine.addIceCandidate({ candidate: "good", sdpMid: "0", sdpMLineIndex: 0 });

    const answering = engine.acceptRemoteOffer("offer-1");
    // The connection exists once fetchIceServers resolves; reject only the bad candidate.
    await vi.waitFor(() => expect(built).toHaveLength(1));
    built[0].addIceCandidate.mockImplementation(async (c: { candidate: string }) => {
      if (c.candidate === "bad") throw new Error("invalid candidate");
    });
    await answering;

    expect(built[0].addIceCandidate).toHaveBeenCalledTimes(2);
    expect(ev.onLocalDescription).toHaveBeenCalledWith({ type: "answer", sdp: "answer-sdp" });
  });
});
