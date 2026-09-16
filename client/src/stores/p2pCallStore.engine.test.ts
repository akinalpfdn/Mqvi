/**
 * The seam between the call store and the media engine. The store owns the call and the
 * signalling; the engine owns the media. These tests pin what crosses that line, because the
 * native engine (iOS) will arrive behind the same interface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { engineInstances } = vi.hoisted(() => ({
  engineInstances: [] as { events: Record<string, (arg?: unknown) => void>; calls: string[] }[],
}));

vi.mock("../call/WebCallEngine", () => ({
  WebCallEngine: class {
    constructor(events: Record<string, (arg?: unknown) => void>) {
      engineInstances.push({ events, calls: [] });
    }
    private get record() {
      return engineInstances[engineInstances.length - 1];
    }
    async start() {
      this.record.calls.push("start");
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
    async setVideoEnabled() {
      return true;
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
