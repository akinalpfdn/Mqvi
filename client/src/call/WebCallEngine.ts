/**
 * WebCallEngine — the peer connection as it has always run: RTCPeerConnection inside the
 * page. Used on web, Electron and Android, and on iOS until the native engine covers a
 * call type.
 *
 * Everything here moved out of p2pCallStore unchanged in behaviour: the glare guard, the
 * candidate queue, the bounded ICE-restart recovery, the degradation preference, the
 * screen-share sender swap.
 */

import { fetchIceServers, fetchIceServersForRecovery } from "../api/calls";
import type { P2PCallType } from "../types";
import type {
  CallEngineEvents,
  CallEngineStart,
  CallMediaEngine,
} from "./CallMediaEngine";

// Mid-call recovery: on a failed connection, attempt an ICE restart (TURN relay candidates
// are already in the pool) before giving up. Bounded so a truly dead call still ends. Each
// attempt gets its own window (enough for TURN/TLS fallback and slow ICE gathering).
const MAX_ICE_RESTARTS = 2;
const ICE_RESTART_ATTEMPT_MS = 7_000;

async function getMediaStream(callType: P2PCallType): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: callType === "video"
      ? { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
      : false,
  });
}

/** "balanced" degradation on video senders — FPS and resolution degrade proportionally. */
function applyDegradationPreference(pc: RTCPeerConnection): void {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    const params = sender.getParameters();
    params.degradationPreference = "balanced";
    sender.setParameters(params).catch((err) => {
      console.warn("[p2p] Failed to set degradationPreference:", err);
    });
  }
}

export class WebCallEngine implements CallMediaEngine {
  private readonly events: CallEngineEvents;

  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private screenSender: RTCRtpSender | null = null;
  private screenTrack: MediaStreamTrack | null = null;

  private opts: CallEngineStart | null = null;
  private closed = false;

  /** Candidates that arrived before the remote description; flushed once it is set. */
  private pendingCandidates: RTCIceCandidateInit[] = [];

  private makingOffer = false;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering = false;
  private attempts = 0;

  constructor(events: CallEngineEvents) {
    this.events = events;
  }

  async start(opts: CallEngineStart): Promise<void> {
    this.opts = opts;
    if (!opts.isCaller) return; // the receiver builds its connection from the first offer

    const stream = await getMediaStream(opts.callType);
    if (this.closed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.setLocalStream(stream);

    const iceServers = await fetchIceServers();
    if (this.closed) return;

    const pc = this.createPeerConnection(iceServers);
    // addTrack triggers onnegotiationneeded, which creates the offer. No explicit
    // createOffer here, or the peer gets two.
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    applyDegradationPreference(pc);
  }

  async acceptRemoteOffer(sdp: string): Promise<void> {
    if (this.closed || !this.opts) return;

    let pc = this.pc;
    if (!pc) {
      // Receiver's first offer. The call is active by now, so the ICE endpoint's gate
      // passes; on failure we continue STUN-only rather than drop the call.
      const iceServers = await fetchIceServers();
      if (this.closed) return;
      pc = this.createPeerConnection(iceServers);

      if (!this.localStream) {
        try {
          const stream = await getMediaStream(this.opts.callType);
          if (this.closed) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          this.setLocalStream(stream);
        } catch (err) {
          // Answering without a microphone leaves a connected call nobody can hear, so
          // the call ends instead of pretending to work.
          console.error("[p2p] Failed to get media for the incoming call:", err);
          this.events.onConnectionLost();
          return;
        }
      }
      const stream = this.localStream;
      if (stream) {
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
      }
      applyDegradationPreference(pc);
    }

    await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp }));
    if (this.closed) return;
    await this.flushCandidates(pc);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (this.closed || !answer.sdp) return;
    this.events.onLocalDescription({ type: "answer", sdp: answer.sdp });
  }

  async acceptRemoteAnswer(sdp: string): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }));
    } catch (err) {
      // Glare or a late answer against an already-stable state.
      console.warn("[p2p] Could not set remote answer (state:", pc.signalingState, "):", err);
      return;
    }
    if (this.closed) return;
    await this.flushCandidates(pc);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.closed) return;
    const pc = this.pc;
    // addIceCandidate throws InvalidStateError while there is no remote description.
    if (!pc || !pc.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  setMicEnabled(enabled: boolean): void {
    if (!this.localStream) return;
    for (const track of this.localStream.getAudioTracks()) track.enabled = enabled;
  }

  async setVideoEnabled(enabled: boolean): Promise<boolean> {
    const pc = this.pc;
    const stream = this.localStream;
    if (!pc || !stream) return false;

    const existing = stream.getVideoTracks()[0];
    if (!enabled) {
      for (const track of stream.getVideoTracks()) track.enabled = false;
      return false;
    }
    if (existing) {
      existing.enabled = true;
      return true;
    }
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      });
      if (this.closed) {
        videoStream.getTracks().forEach((t) => t.stop());
        return false;
      }
      const videoTrack = videoStream.getVideoTracks()[0];
      stream.addTrack(videoTrack);
      // addTrack triggers onnegotiationneeded, which renegotiates.
      pc.addTrack(videoTrack, stream);
      return true;
    } catch (err) {
      console.error("[p2p] Failed to get video:", err);
      return false;
    }
  }

  async startScreenShare(): Promise<boolean> {
    const pc = this.pc;
    if (!pc || this.closed) return false;

    let screenStream: MediaStream;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
      });
    } catch (err) {
      console.error("[p2p] Screen share error:", err);
      return false;
    }

    const screenTrack = screenStream.getVideoTracks()[0];
    if (this.closed || this.pc !== pc) {
      screenTrack.stop();
      return false;
    }

    let videoSender = pc.getSenders().find((s) => s.track?.kind === "video") ?? null;
    if (!videoSender) {
      // Voice-only call: add a video transceiver and wait for the renegotiation it triggers
      // to complete. Two phases — leaving "stable", then returning to it.
      const transceiver = pc.addTransceiver("video", { direction: "sendrecv" });
      videoSender = transceiver.sender;
      await new Promise<void>((resolve) => {
        const waitForStart = () => {
          if (pc.signalingState !== "stable") {
            const waitForEnd = () => {
              if (pc.signalingState === "stable") resolve();
              else setTimeout(waitForEnd, 50);
            };
            waitForEnd();
          } else {
            setTimeout(waitForStart, 20);
          }
        };
        setTimeout(waitForStart, 20);
      });
    }

    if (this.closed || this.pc !== pc) {
      screenTrack.stop();
      return false;
    }

    await videoSender.replaceTrack(screenTrack);
    const params = videoSender.getParameters();
    params.degradationPreference = "balanced";
    await videoSender.setParameters(params).catch(() => {});

    this.screenSender = videoSender;
    this.screenTrack = screenTrack;
    // The browser's own "stop sharing" control ends the track without telling the app.
    screenTrack.onended = () => {
      if (this.screenTrack !== screenTrack) return;
      this.stopScreenShare();
      this.events.onScreenShareEnded();
    };
    return true;
  }

  stopScreenShare(): void {
    const sender = this.screenSender;
    this.screenSender = null;
    const track = this.screenTrack;
    this.screenTrack = null;
    if (track) {
      track.onended = null;
      track.stop();
    }
    if (sender) {
      const camera = this.localStream?.getVideoTracks()[0] ?? null;
      sender.replaceTrack(camera).catch(() => {});
    }
  }

  restartIce(): void {
    this.startRecovery();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearDisconnectedTimer();
    this.stopRecovery();

    const pc = this.pc;
    if (pc) {
      for (const sender of pc.getSenders()) sender.track?.stop();
      for (const receiver of pc.getReceivers()) receiver.track?.stop();
    }
    for (const track of this.localStream?.getTracks() ?? []) track.stop();
    for (const track of this.remoteStream?.getTracks() ?? []) track.stop();
    this.screenTrack?.stop();
    this.screenTrack = null;
    this.screenSender = null;
    pc?.close();
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;
    this.pendingCandidates = [];
  }

  // ─── internals ───

  private setLocalStream(stream: MediaStream): void {
    this.localStream = stream;
    this.events.onLocalStream(stream);
  }

  private async flushCandidates(pc: RTCPeerConnection): Promise<void> {
    if (this.pendingCandidates.length === 0) return;
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      if (this.closed || this.pc !== pc) return;
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  private createPeerConnection(iceServers: RTCIceServer[]): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;

    // Every callback bails once this connection is no longer the engine's — a connection
    // that lost a concurrent-offer race must not drive the live call.
    const isCurrent = () => this.pc === pc && !this.closed;

    pc.onicecandidate = (event) => {
      if (!isCurrent() || !event.candidate) return;
      this.events.onIceCandidate(event.candidate.toJSON());
    };

    pc.ontrack = (event) => {
      if (!isCurrent()) return;
      if (event.streams[0]) {
        this.remoteStream = event.streams[0];
      } else {
        // Mid-call addTransceiver (screen share) arrives with no stream; keep the audio
        // that is already playing.
        const stream = new MediaStream(this.remoteStream ? this.remoteStream.getTracks() : []);
        stream.addTrack(event.track);
        this.remoteStream = stream;
      }
      this.events.onRemoteStream(this.remoteStream);
    };

    pc.onconnectionstatechange = () => {
      if (!isCurrent()) return;
      switch (pc.connectionState) {
        case "connected":
          this.clearDisconnectedTimer();
          this.stopRecovery();
          return;
        case "connecting":
          this.clearDisconnectedTimer();
          return;
        case "failed":
          this.clearDisconnectedTimer();
          this.startRecovery();
          return;
        case "closed":
          this.endNow();
          return;
        case "disconnected": {
          // May be a transient blip; give it a window before treating it as failure.
          const timeout = pc.signalingState !== "stable" ? 10000 : 5000;
          console.warn("[p2p] PeerConnection disconnected, waiting for recovery...", {
            signalingState: pc.signalingState,
            timeout,
          });
          if (!this.disconnectedTimer) {
            this.disconnectedTimer = setTimeout(() => {
              this.disconnectedTimer = null;
              if (!isCurrent()) return;
              if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
                this.startRecovery();
              }
            }, timeout);
          }
          return;
        }
      }
    };

    // Sole offer creation point, initial and renegotiation. The makingOffer flag and the
    // signalling-state guard keep simultaneous offers from clobbering the m-line order.
    pc.onnegotiationneeded = async () => {
      if (!isCurrent()) return;
      if (this.makingOffer || pc.signalingState !== "stable") return;
      try {
        this.makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (!isCurrent() || !offer.sdp) return;
        this.events.onLocalDescription({ type: "offer", sdp: offer.sdp });
      } catch (err) {
        console.error("[p2p] Renegotiation error:", err);
      } finally {
        this.makingOffer = false;
      }
    };

    return pc;
  }

  private clearDisconnectedTimer(): void {
    if (this.disconnectedTimer) {
      clearTimeout(this.disconnectedTimer);
      this.disconnectedTimer = null;
    }
  }

  private stopRecovery(): void {
    this.recovering = false;
    this.attempts = 0;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private endNow(): void {
    this.clearDisconnectedTimer();
    this.stopRecovery();
    this.events.onConnectionLost();
  }

  /** On fetch failure keep the current (TURN) configuration rather than downgrade to STUN. */
  private async refreshIceServers(pc: RTCPeerConnection): Promise<void> {
    const iceServers = await fetchIceServersForRecovery();
    if (this.pc !== pc || this.closed || !iceServers) return;
    try {
      // Spread the current configuration so only iceServers changes.
      pc.setConfiguration({ ...pc.getConfiguration(), iceServers });
    } catch (err) {
      console.error("[p2p] setConfiguration during recovery failed:", err);
    }
  }

  private async recoveryStep(pc: RTCPeerConnection): Promise<void> {
    const alive = () => this.pc === pc && !this.closed;
    // Closure reads, so TypeScript does not narrow the state away across the awaits.
    const isConnected = () => pc.connectionState === "connected";
    if (!alive() || isConnected()) {
      this.stopRecovery();
      return;
    }
    if (this.attempts >= MAX_ICE_RESTARTS) {
      console.warn("[p2p] ICE restart cap reached, ending call");
      this.endNow();
      return;
    }
    this.attempts++;
    const role = this.opts?.isCaller ? "caller" : "receiver";
    console.warn(`[p2p] ICE restart attempt ${this.attempts}/${MAX_ICE_RESTARTS} (${role})`);
    await this.refreshIceServers(pc);
    if (!alive() || !this.recovering || isConnected()) {
      this.stopRecovery();
      return;
    }

    // Only the offerer can restart ICE; the answerer asks it to.
    if (this.opts?.isCaller) {
      try {
        pc.restartIce();
      } catch (err) {
        console.error("[p2p] restartIce error:", err);
      }
    } else {
      this.events.onIceRestartNeeded();
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.recoveryStep(pc);
    }, ICE_RESTART_ATTEMPT_MS);
  }

  private startRecovery(): void {
    const pc = this.pc;
    if (!pc || this.closed) return;
    if (this.recovering) return; // own failure and a peer request may coincide
    this.recovering = true;
    this.attempts = 0;
    void this.recoveryStep(pc);
  }
}
