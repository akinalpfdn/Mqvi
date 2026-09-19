/** What crosses between the call store and the media engine. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { engineInstances, pendingSwitches, pendingVideo, startFailure } = vi.hoisted(() => ({
  /** When set, the engine's start rejects with it — a denied microphone, say. */
  startFailure: { current: null as Error | null },
  /** Resolvers for camera on/off requests still in flight, oldest first. */
  pendingVideo: [] as ((enabled: boolean) => void)[],
  engineInstances: [] as { events: Record<string, (arg?: unknown) => void>; calls: string[] }[],
  /** Resolvers for camera switches still in flight, oldest first. */
  pendingSwitches: [] as ((facing: "front" | "back" | null) => void)[],
}));

vi.mock("../call/WebCallEngine", () => ({
  WebCallEngine: class {
    constructor(events: Record<string, (arg?: unknown) => void>) {
      engineInstances.push({ events, calls: [] });
    }
    private get record() {
      return engineInstances[engineInstances.length - 1];
    }
    async start(opts: { endKey?: string }) {
      this.record.calls.push(opts.endKey ? `start:${opts.endKey}` : "start");
      if (startFailure.current) throw startFailure.current;
    }
    async acceptRemoteOffer(sdp: string) {
      this.record.calls.push(`acceptRemoteOffer:${sdp}`);
    }
    async acceptRemoteAnswer(sdp: string) {
      this.record.calls.push(`acceptRemoteAnswer:${sdp}`);
    }
    async addIceCandidate() {
      this.record.calls.push("addIceCandidate");
    }
    setMicEnabled(enabled: boolean) {
      this.record.calls.push(`setMicEnabled:${enabled}`);
    }
    setRemoteVolume(percent: number) {
      this.record.calls.push(`setRemoteVolume:${percent}`);
    }
    resync() {
      this.record.calls.push("resync");
    }
    setVideoEnabled() {
      this.record.calls.push("setVideoEnabled");
      return new Promise<boolean>((resolve) => pendingVideo.push(resolve));
    }
    switchCamera() {
      this.record.calls.push("switchCamera");
      return new Promise<"front" | "back" | null>((resolve) => pendingSwitches.push(resolve));
    }
    async startScreenShare() {
      return true;
    }
    stopScreenShare() {}
    restartIce() {
      this.record.calls.push("restartIce");
    }
    close() {
      this.record.calls.push("close");
    }
  },
}));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("./toastStore", () => ({ useToastStore: { getState: () => ({ addToast: vi.fn() }) } }));
vi.mock("../utils/nativePlugins", () => ({
  startVoiceCallService: vi.fn(),
  stopVoiceCallService: vi.fn(),
}));
vi.mock("../native/p2pCall", () => ({ dismissIncomingCallUI: vi.fn() }));

import { useP2PCallStore } from "./p2pCallStore";
import { endP2PCallForLogout, endP2PCallForVoice } from "./shared/p2pCallControl";
import type { P2PCall } from "../types";

const sendWS = vi.fn();

function makeCall(): P2PCall {
  return {
    id: "c1",
    caller_id: "them",
    caller_username: "them",
    caller_display_name: null,
    caller_avatar: null,
    receiver_id: "me",
    receiver_username: "me",
    receiver_display_name: null,
    receiver_avatar: null,
    call_type: "voice",
    status: "active",
    created_at: "",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  engineInstances.length = 0;
  pendingSwitches.length = 0;
  pendingVideo.length = 0;
  startFailure.current = null;
  useP2PCallStore.setState({
    activeCall: makeCall(),
    incomingCall: null,
    engine: null,
    localStream: null,
    remoteStream: null,
    isMuted: false,
    isVideoOn: false,
    isScreenSharing: false,
    _durationInterval: null,
    _sendWS: sendWS,
  });
});

describe("store → engine", () => {
  it("should hand a remote offer, answer and candidate to the engine", async () => {
    await useP2PCallStore.getState().startWebRTC(false);
    await useP2PCallStore.getState().handleSignal({ call_id: "c1", type: "offer", sdp: "o" });
    await useP2PCallStore.getState().handleSignal({ call_id: "c1", type: "answer", sdp: "a" });
    await useP2PCallStore
      .getState()
      .handleSignal({ call_id: "c1", type: "ice-candidate", candidate: { candidate: "x" } });

    expect(engineInstances).toHaveLength(1);
    expect(engineInstances[0].calls).toEqual([
      "start",
      "acceptRemoteOffer:o",
      "acceptRemoteAnswer:a",
      "addIceCandidate",
    ]);
  });

  it("should build an engine when the offer arrives before the accept handler ran", async () => {
    await useP2PCallStore.getState().handleSignal({ call_id: "c1", type: "offer", sdp: "o" });

    expect(engineInstances).toHaveLength(1);
    expect(engineInstances[0].calls).toEqual(["start", "acceptRemoteOffer:o"]);
  });

  it("should close the engine when the call is cleaned up", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.getState().cleanup();

    expect(engineInstances[0].calls).toContain("close");
    expect(useP2PCallStore.getState().engine).toBeNull();
  });

  it("should hand the peer's volume to the engine, clamped to the slider's range", async () => {
    // A native call plays the audio itself; the page's <audio> element never exists there.
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.getState().setRemoteVolume(150);
    useP2PCallStore.getState().setRemoteVolume(900);

    expect(engineInstances[0].calls).toContain("setRemoteVolume:150");
    expect(engineInstances[0].calls).toContain("setRemoteVolume:200");
  });

  it("should mute through the engine, not by touching tracks itself", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.getState().toggleMute();

    expect(engineInstances[0].calls).toContain("setMicEnabled:false");
    expect(useP2PCallStore.getState().isMuted).toBe(true);
  });
});

describe("engine → store", () => {
  it("should signal local descriptions, candidates and restart requests to the peer", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    const { events } = engineInstances[0];

    events.onLocalDescription({ type: "offer", sdp: "sdp-1" } as never);
    events.onIceCandidate({ candidate: "cand-1" } as never);
    events.onIceRestartNeeded();

    expect(sendWS).toHaveBeenCalledWith("p2p_signal", { call_id: "c1", type: "offer", sdp: "sdp-1" });
    expect(sendWS).toHaveBeenCalledWith("p2p_signal", {
      call_id: "c1",
      type: "ice-candidate",
      candidate: { candidate: "cand-1" },
    });
    expect(sendWS).toHaveBeenCalledWith("p2p_signal", { call_id: "c1", type: "ice-restart" });
  });

  it("should put the engine's streams into state", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    const { events } = engineInstances[0];
    const local = { id: "local" } as never;
    const remote = { id: "remote" } as never;

    events.onLocalStream(local);
    events.onRemoteStream(remote);

    expect(useP2PCallStore.getState().localStream).toBe(local);
    expect(useP2PCallStore.getState().remoteStream).toBe(remote);
  });

  it("should not signal for a call the user has already left", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    const { events } = engineInstances[0];
    useP2PCallStore.setState({ activeCall: { ...makeCall(), id: "c2" } });

    events.onLocalDescription({ type: "offer", sdp: "late" } as never);

    expect(sendWS).not.toHaveBeenCalledWith(
      "p2p_signal",
      expect.objectContaining({ sdp: "late" }),
    );
  });
});

/** The peer's picture: its announcement wins, and a peer that never announces is judged by its track. */
describe("the peer's picture", () => {
  const videoSignals = () =>
    sendWS.mock.calls
      .map(([, data]) => (data as { type: string }).type)
      .filter((type) => type === "video-on" || type === "video-off");

  beforeEach(() => {
    useP2PCallStore.setState({ hasRemoteVideo: false, remoteTrackVideo: false, peerVideoOff: false });
  });

  it("should fall back to the avatar when the peer turns its camera off, though the track stays", async () => {
    await useP2PCallStore.getState().startWebRTC(false);
    engineInstances[0].events.onRemoteVideo(true);
    expect(useP2PCallStore.getState().hasRemoteVideo).toBe(true);

    await useP2PCallStore.getState().handleSignal({ call_id: "c1", type: "video-off" });
    expect(useP2PCallStore.getState().hasRemoteVideo).toBe(false);

    await useP2PCallStore.getState().handleSignal({ call_id: "c1", type: "video-on" });
    expect(useP2PCallStore.getState().hasRemoteVideo).toBe(true);
  });

  it("should judge a peer that never announces by its track alone", async () => {
    await useP2PCallStore.getState().startWebRTC(false);
    engineInstances[0].events.onRemoteVideo(true);
    expect(useP2PCallStore.getState().hasRemoteVideo).toBe(true);
    engineInstances[0].events.onRemoteVideo(false);
    expect(useP2PCallStore.getState().hasRemoteVideo).toBe(false);
  });

  it("should not show a picture the peer announces before any track exists", async () => {
    await useP2PCallStore.getState().startWebRTC(false);
    await useP2PCallStore.getState().handleSignal({ call_id: "c1", type: "video-on" });
    expect(useP2PCallStore.getState().hasRemoteVideo).toBe(false);
  });

  it("should announce once per change, counting a screen share as a picture", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    sendWS.mockClear();

    useP2PCallStore.setState({ isVideoOn: true });
    useP2PCallStore.setState({ isScreenSharing: true }); // still sending a picture
    useP2PCallStore.setState({ isVideoOn: false }); // the screen is still on the track
    useP2PCallStore.setState({ isScreenSharing: false });

    expect(videoSignals()).toEqual(["video-on", "video-off"]);
  });

  it("should stop announcing once the call is over", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.getState().cleanup();
    sendWS.mockClear();

    useP2PCallStore.setState({ activeCall: makeCall(), isVideoOn: true });
    expect(videoSignals()).toEqual([]);
  });
});

/** A mute made before the engine exists reaches it. */
describe("a mute made before the engine exists", () => {
  it("should reach the engine the moment it is created", async () => {
    useP2PCallStore.getState().toggleMute();
    expect(useP2PCallStore.getState().isMuted).toBe(true);

    await useP2PCallStore.getState().startWebRTC(false);
    expect(engineInstances[0].calls).toContain("setMicEnabled:false");
  });

  it("should leave an unmuted call's engine alone", async () => {
    await useP2PCallStore.getState().startWebRTC(false);
    expect(engineInstances[0].calls.filter((c) => c.startsWith("setMicEnabled"))).toEqual([]);
  });
});

/** One camera switch at a time. */
describe("switching the camera", () => {
  beforeEach(() => {
    useP2PCallStore.setState({ isVideoOn: true, cameraFacing: "front", _mediaChanging: false });
  });

  it("should ignore a second press while the first switch is still in flight", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.getState().switchCamera();
    useP2PCallStore.getState().switchCamera();
    expect(engineInstances[0].calls.filter((c) => c === "switchCamera")).toHaveLength(1);

    pendingSwitches[0]("back");
    await vi.waitFor(() => expect(useP2PCallStore.getState().cameraFacing).toBe("back"));

    // Once it has landed, the next press goes through.
    useP2PCallStore.getState().switchCamera();
    expect(engineInstances[0].calls.filter((c) => c === "switchCamera")).toHaveLength(2);
  });

  it("should accept presses again after a switch that could not happen", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.getState().switchCamera();
    pendingSwitches[0](null); // a phone with one camera
    await vi.waitFor(() => expect(useP2PCallStore.getState()._mediaChanging).toBe(false));
    expect(useP2PCallStore.getState().cameraFacing).toBe("front");
  });
});

/** Voice join ends a live call; sign-out ends any call. */
describe("ending the call for a voice channel or a sign-out", () => {
  const ended = () => sendWS.mock.calls.filter(([op]) => op === "p2p_call_end").length;

  it("should end a call whose media is up when a voice channel is joined", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    endP2PCallForVoice();
    expect(ended()).toBe(1);
    expect(useP2PCallStore.getState().activeCall).toBeNull();
    expect(engineInstances[0].calls).toContain("close");
  });

  it("should leave a ringing call alone for a voice channel — it has no media yet", () => {
    useP2PCallStore.setState({ activeCall: { ...makeCall(), status: "ringing" } });
    endP2PCallForVoice();
    expect(ended()).toBe(0);
    expect(useP2PCallStore.getState().activeCall).not.toBeNull();
  });

  it("should end even a ringing call on sign-out", () => {
    useP2PCallStore.setState({ activeCall: { ...makeCall(), status: "ringing" } });
    endP2PCallForLogout();
    expect(ended()).toBe(1);
    expect(useP2PCallStore.getState().activeCall).toBeNull();
  });

  it("should still tear the media down on sign-out when there is no socket to tell the server", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.setState({ _sendWS: null });
    endP2PCallForLogout();
    expect(engineInstances[0].calls).toContain("close");
    expect(useP2PCallStore.getState().activeCall).toBeNull();
  });
});

/** Camera and screen changes: one at a time, and a late result stays with its own call. */
describe("camera and screen changes", () => {
  beforeEach(() => {
    useP2PCallStore.setState({ isVideoOn: false, _mediaChanging: false });
  });

  it("should not apply a late camera result to the call that came after", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.getState().toggleVideo();

    // That call ends and a video call starts while the camera prompt is still open.
    useP2PCallStore.getState().cleanup();
    useP2PCallStore.setState({ activeCall: makeCall(), _sendWS: sendWS, isVideoOn: false });
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.setState({ isVideoOn: true });

    pendingVideo[0](false); // the first call's engine answers at last
    await Promise.resolve();
    await Promise.resolve();
    expect(useP2PCallStore.getState().isVideoOn).toBe(true);
  });

  it("should start one camera change at a time", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.getState().toggleVideo();
    useP2PCallStore.getState().toggleVideo();
    expect(engineInstances[0].calls.filter((c) => c === "setVideoEnabled")).toHaveLength(1);

    pendingVideo[0](true);
    await vi.waitFor(() => expect(useP2PCallStore.getState()._mediaChanging).toBe(false));
    expect(useP2PCallStore.getState().isVideoOn).toBe(true);
  });
});

/** After a reconnect, re-send our picture and ask for theirs. */
describe("announcing the picture after a reconnect", () => {
  const signals = () =>
    sendWS.mock.calls
      .filter(([op]) => op === "p2p_signal")
      .map(([, data]) => (data as { type: string }).type);

  it("should re-send our picture and ask the peer for theirs", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.setState({ isVideoOn: true });
    sendWS.mockClear();

    useP2PCallStore.getState().resumeCallAfterReconnect();
    expect(signals()).toEqual(["video-query", "video-on"]);
  });

  it("should have the engine re-send whatever negotiation the old socket may have lost", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.getState().resumeCallAfterReconnect();
    expect(engineInstances[0].calls).toContain("resync");
  });

  it("should answer the peer's question with our picture", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    useP2PCallStore.setState({ isVideoOn: false });
    sendWS.mockClear();

    await useP2PCallStore.getState().handleSignal({ call_id: "c1", type: "video-query" });
    expect(signals()).toEqual(["video-off"]);
  });
});

/** Media that fails to start ends the call on the server too. */
describe("a call whose media fails to start", () => {
  const ends = () => sendWS.mock.calls.filter(([op]) => op === "p2p_call_end");

  it("should end the call for both sides when start fails after accepting", async () => {
    startFailure.current = new Error("microphone permission denied");
    await useP2PCallStore.getState().startWebRTC(false);

    expect(ends()).toEqual([["p2p_call_end", { call_id: "c1" }]]);
    expect(useP2PCallStore.getState().activeCall).toBeNull();
  });

  it("should end the call when start fails on the path where the offer came first", async () => {
    startFailure.current = new Error("microphone permission denied");
    await useP2PCallStore.getState().handleSignal({ call_id: "c1", type: "offer", sdp: "o" });

    expect(ends()).toEqual([["p2p_call_end", { call_id: "c1" }]]);
    expect(engineInstances[0].calls).not.toContain("acceptRemoteOffer:o");
  });

  it("should not end a newer call when an older call's start fails late", async () => {
    let fail!: (err: Error) => void;
    startFailure.current = null;
    const late = new Promise<void>((_, reject) => {
      fail = reject;
    });
    await useP2PCallStore.getState().startWebRTC(false);
    const engine = useP2PCallStore.getState().engine as unknown as { start: () => Promise<void> };
    engine.start = () => late;

    const starting = useP2PCallStore.getState().startWebRTC(false);
    useP2PCallStore.setState({ activeCall: { ...makeCall(), id: "c2" } });
    fail(new Error("late"));
    await starting;

    expect(ends()).toEqual([]);
    expect(useP2PCallStore.getState().activeCall?.id).toBe("c2");
  });
});

describe("a repeated accept", () => {
  it("should not start a second duration timer", () => {
    vi.useFakeTimers();
    try {
      useP2PCallStore.setState({ activeCall: { ...makeCall(), status: "ringing" }, callDuration: 0 });
      useP2PCallStore.getState().handleCallAccept({ call_id: "c1" });
      useP2PCallStore.getState().handleCallAccept({ call_id: "c1" });
      vi.advanceTimersByTime(3_000);
      expect(useP2PCallStore.getState().callDuration).toBe(3);
    } finally {
      useP2PCallStore.getState().cleanup();
      vi.useRealTimers();
    }
  });
});

describe("an offer on a device that did not take the call", () => {
  it("should not answer on a ringing sibling that missed the accept", async () => {
    useP2PCallStore.setState({ activeCall: { ...makeCall(), status: "ringing" }, _acceptSentFor: null });
    await useP2PCallStore.getState().handleSignal({ call_id: "c1", type: "offer", sdp: "o" });
    expect(engineInstances).toHaveLength(0);
  });

  it("should still answer on the device that sent the accept, if the offer beats it", async () => {
    useP2PCallStore.setState({
      activeCall: { ...makeCall(), status: "ringing" },
      incomingCall: { ...makeCall(), status: "ringing" },
    });
    useP2PCallStore.getState().acceptCall("c1");
    await useP2PCallStore.getState().handleSignal({ call_id: "c1", type: "offer", sdp: "o" });
    expect(engineInstances[0].calls).toContain("acceptRemoteOffer:o");
  });
});

describe("the hang-up key and the peer's goodbye", () => {
  it("should start the engine with this side's key from the accept", async () => {
    useP2PCallStore.getState().handleCallAccept({ call_id: "c1", end_key: "receiver-key" } as never);
    await useP2PCallStore.getState().startWebRTC(false);

    expect(engineInstances[0].calls).toContain("start:receiver-key");
  });

  it("should end the call on the peer's goodbye and tell the server, which may not know yet", async () => {
    await useP2PCallStore.getState().startWebRTC(true);
    sendWS.mockClear();

    engineInstances[0].events.onPeerHungUp();

    expect(useP2PCallStore.getState().activeCall).toBeNull();
    expect(sendWS).toHaveBeenCalledWith("p2p_call_end", { call_id: "c1" });
  });
});
