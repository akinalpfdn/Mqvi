/** The web engine's camera flip on phones that cannot hold two cameras open at once. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { fetchIceServers } = vi.hoisted(() => ({ fetchIceServers: vi.fn() }));
vi.mock("../api/calls", () => ({ fetchIceServers, fetchIceServersForRecovery: vi.fn() }));

import { WebCallEngine } from "./WebCallEngine";
import type { CallEngineEvents } from "./CallMediaEngine";

type FakeTrack = { kind: string; label: string; enabled: boolean; stop: ReturnType<typeof vi.fn>; live: boolean };

function track(kind: string, label: string): FakeTrack {
  const t: FakeTrack = { kind, label, enabled: true, live: true, stop: vi.fn() };
  t.stop.mockImplementation(() => {
    t.live = false;
  });
  return t;
}

function stream(tracks: FakeTrack[]) {
  const list = [...tracks];
  return {
    getTracks: () => [...list],
    getAudioTracks: () => list.filter((t) => t.kind === "audio"),
    getVideoTracks: () => list.filter((t) => t.kind === "video"),
    addTrack: (t: FakeTrack) => list.push(t),
    removeTrack: (t: FakeTrack) => list.splice(list.indexOf(t), 1),
  };
}

type FakeSender = {
  track: FakeTrack | null;
  replaceTrack: ReturnType<typeof vi.fn>;
  getParameters: () => object;
  setParameters: () => Promise<void>;
};

let sender: FakeSender;
/** Which cameras exist. */
let cameras: Record<string, boolean>;
let front: FakeTrack;
const originalPC = globalThis.RTCPeerConnection;

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
    onPeerHungUp: vi.fn(),
  } satisfies CallEngineEvents;
}

beforeEach(() => {
  fetchIceServers.mockReset().mockResolvedValue([]);
  front = track("video", "front");
  sender = {
    track: null,
    replaceTrack: vi.fn(async (t: FakeTrack | null) => {
      sender.track = t;
    }),
    getParameters: () => ({}),
    setParameters: async () => {},
  };
  cameras = { user: true, environment: true };
  globalThis.RTCPeerConnection = function FakeRTCPeerConnection() {
    return {
      connectionState: "new",
      signalingState: "stable",
      close: vi.fn(),
      addTrack: vi.fn((t: FakeTrack) => {
        if (t.kind === "video") sender.track = t;
      }),
      getSenders: () => [sender],
      getReceivers: () => [],
      createDataChannel: () => ({ readyState: "connecting", send: vi.fn(), onmessage: null }),
    };
  } as unknown as typeof RTCPeerConnection;

  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    if (constraints.audio) return stream([track("audio", "mic"), front]);
    const facing = (constraints.video as MediaTrackConstraints).facingMode as string;
    // One camera at a time, as on most phones: the other must be released first.
    if (front.live && facing === "environment") throw new DOMException("busy", "NotReadableError");
    if (!cameras[facing]) throw new DOMException("none", "OverconstrainedError");
    return stream([track("video", facing === "user" ? "front" : "back")]);
  });
  Object.defineProperty(globalThis.navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
});

afterEach(() => {
  globalThis.RTCPeerConnection = originalPC;
});

async function videoCall() {
  const ev = events();
  const engine = new WebCallEngine(ev);
  await engine.start({ callId: "c1", callType: "video", isCaller: true });
  return { engine, ev };
}

describe("switching camera", () => {
  it("should release the camera in use before opening the other", async () => {
    const { engine } = await videoCall();

    await expect(engine.switchCamera()).resolves.toBe("back");

    expect(front.stop).toHaveBeenCalled();
    expect(sender.track?.label).toBe("back");
  });

  it("should bring the first camera back when the other will not open", async () => {
    cameras.environment = false;
    const { engine } = await videoCall();

    await expect(engine.switchCamera()).resolves.toBeNull();

    expect(sender.track?.label).toBe("front");
    expect(sender.track?.live).toBe(true);
  });

  it("should turn the video off, and say so, when neither camera opens again", async () => {
    cameras.environment = false;
    cameras.user = false;
    const { engine, ev } = await videoCall();

    await expect(engine.switchCamera()).resolves.toBeNull();

    expect(sender.track).toBeNull();
    expect(ev.onLocalVideo).toHaveBeenLastCalledWith(false);
  });
});
