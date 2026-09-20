/**
 * The iOS engine: peer connection, microphone, camera and audio output live in the native
 * plugin, because WKWebView never gets the microphone while CallKit owns the audio session.
 */

import { fetchIceServers } from "../api/calls";
import { NativeP2PCall, type NativeConnectionState } from "../native/nativeP2PCall";
import { nativeVoiceReleased } from "../utils/nativePlugins";
import { INSTANCE_ID } from "../utils/deviceId";
import { SERVER_URL } from "../utils/constants";
import type { PluginListenerHandle } from "@capacitor/core";
import type {
  CallEngineEvents,
  CallEngineStart,
  CallMediaEngine,
  CameraFacing,
  TakeOverCall,
} from "./CallMediaEngine";
import { DISCONNECT_GRACE_MS, IceRecovery } from "./IceRecovery";

/** Longest the call waits for channel voice to release the audio session. */
const VOICE_RELEASE_WAIT_MS = 3_000;

/** Waits for `settled`, but no longer than `ms`. */
function atMost(settled: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void settled.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class NativeCallEngine implements CallMediaEngine {
  readonly rendersVideoNatively = true;

  private readonly events: CallEngineEvents;
  private readonly handles: PluginListenerHandle[] = [];

  private started = false;
  private closed = false;
  /** Resolves once start() has finished. See waitUntilStarted. */
  private ready: Promise<void> | null = null;
  /** The call this engine was started for; plugin events naming another call are dropped. */
  private callId: string | null = null;
  private endKey: string | undefined;
  /** Native owns the call from start's invocation, including while permission is pending. */
  private nativeStartRequested = false;
  private offerChain: Promise<void> = Promise.resolve();
  private state: NativeConnectionState = "new";
  private isCaller = false;
  private readonly recovery: IceRecovery;
  /** Candidates that arrived before a remote description; the native side rejects those. */
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;

  constructor(events: CallEngineEvents) {
    this.events = events;
    this.recovery = new IceRecovery({
      isCaller: () => this.isCaller,
      isAlive: () => !this.closed && this.started,
      isConnected: () => this.state === "connected",
      // No signalling state from native, so every disconnect gets the shorter window.
      gracePeriodMs: () => DISCONNECT_GRACE_MS,
      applyIceServers: async (servers) => {
        await NativeP2PCall.setIceServers({
          iceServers: servers.map((server) => ({
            urls: server.urls,
            username: server.username,
            credential: typeof server.credential === "string" ? server.credential : undefined,
          })),
        }).catch((err) => console.error("[p2p] native setIceServers failed:", err));
      },
      restartIce: () => {
        void NativeP2PCall.restartIce().catch((err) =>
          console.error("[p2p] native restartIce failed:", err),
        );
      },
      requestRestart: () => this.events.onIceRestartNeeded(),
      onGiveUp: () => this.events.onConnectionLost(),
    });
  }

  /** Idempotent: an offer beating the accept handler starts it twice. */
  start(opts: CallEngineStart): Promise<void> {
    this.endKey ??= opts.endKey;
    this.ready ??= this.begin(opts);
    return this.ready;
  }

  /** Waits for start instead of dropping: an offer landing behind a permission prompt is never re-sent. */
  private async waitUntilStarted(): Promise<boolean> {
    if (!this.ready) return false;
    try {
      await this.ready;
    } catch {
      return false; // start() failed; the store tears the call down
    }
    return !this.closed && this.started;
  }

  /** The state the page missed while it was gone is read back and fed to recovery. */
  async takeOver(call: TakeOverCall): Promise<boolean> {
    this.ready ??= this.attach(call);
    await this.ready;
    return !this.closed && this.started;
  }

  private async attach(call: TakeOverCall): Promise<void> {
    if (this.closed) return;
    this.callId = call.callId;
    this.isCaller = call.isCaller;
    await this.listenForCall();
    if (this.closed) return;
    // This page runs the call now: a later reload must take it over, or hang it up, as this one.
    try {
      await NativeP2PCall.setOwner({ callId: call.callId, instanceId: INSTANCE_ID });
    } catch (err) {
      console.error("[p2p] native setOwner failed:", err);
      return; // ended or replaced while the page was attaching
    }
    if (this.closed) return;
    this.started = true;
    this.hasRemoteDescription = true;
    if (call.state !== "connected") this.recovery.armFirstConnect();
    this.onConnectionState(call.state);
  }

  private async begin(opts: CallEngineStart): Promise<void> {
    if (this.closed) return;
    this.recovery.armFirstConnect();
    this.callId = opts.callId;
    await this.listenForCall();
    await this.startCall(opts);
  }

  private async listenForCall(): Promise<void> {
    const mine = (data: { callId: string }) => !this.closed && data.callId === this.callId;
    await this.listen(
      NativeP2PCall.addListener("localDescription", (desc) => {
        if (mine(desc)) this.events.onLocalDescription({ type: desc.type, sdp: desc.sdp });
      }),
    );
    await this.listen(
      NativeP2PCall.addListener("iceCandidate", (candidate) => {
        if (!mine(candidate)) return;
        this.events.onIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid || null,
          sdpMLineIndex: candidate.sdpMLineIndex,
        });
      }),
    );
    await this.listen(
      NativeP2PCall.addListener("connectionState", (data) => {
        if (mine(data)) this.onConnectionState(data.state);
      }),
    );
    await this.listen(
      NativeP2PCall.addListener("remoteVideo", (data) => {
        if (mine(data)) this.events.onRemoteVideo(data.available);
      }),
    );
    await this.listen(
      NativeP2PCall.addListener("localVideo", (data) => {
        if (mine(data)) this.events.onLocalVideo(data.available);
      }),
    );
    await this.listen(
      NativeP2PCall.addListener("peerHungUp", (data) => {
        if (mine(data)) this.events.onPeerHungUp();
      }),
    );
  }

  private async startCall(opts: CallEngineStart): Promise<void> {
    if (this.closed) return;
    const iceServers = await fetchIceServers();
    if (this.closed) return;

    // Starting the call left the voice channel; LiveKit may still be letting go of the audio
    // session. Bounded, so a disconnect that never settles cannot keep the call from starting.
    await atMost(nativeVoiceReleased(), VOICE_RELEASE_WAIT_MS);
    if (this.closed) return;

    this.isCaller = opts.isCaller;
    let video: boolean;
    try {
      this.nativeStartRequested = true;
      ({ video } = await NativeP2PCall.start({
        callId: opts.callId,
        instanceId: INSTANCE_ID,
        serverUrl: SERVER_URL,
        endKey: this.endKey,
        isCaller: opts.isCaller,
        callType: opts.callType,
        iceServers: iceServers.map((server) => ({
          urls: server.urls,
          username: server.username,
          credential: typeof server.credential === "string" ? server.credential : undefined,
        })),
      }));
    } catch (err) {
      // Closed while the plugin sat on a permission prompt: it declines to build the call, and
      // that is the outcome we asked for, not a failure.
      if (this.closed) return;
      throw err;
    }
    if (this.closed) return;
    this.started = true;
    // Covers an accept arriving after start crossed the bridge, including a permission wait.
    if (this.endKey) this.setEndKey(this.endKey);
    // A video call publishes the camera from the start; the button has to know that, and it
    // has to know when a denied camera means it did not.
    this.events.onLocalVideo(video);
  }

  /** One offer at a time: the plugin's set-remote/answer/set-local callbacks would interleave. */
  acceptRemoteOffer(sdp: string): Promise<void> {
    const run = this.offerChain.then(() => this.applyRemoteOffer(sdp));
    this.offerChain = run.catch(() => {});
    return run;
  }

  private async applyRemoteOffer(sdp: string): Promise<void> {
    if (!(await this.waitUntilStarted())) return;
    await NativeP2PCall.acceptRemoteOffer({ sdp });
    this.hasRemoteDescription = true;
    await this.flushCandidates();
  }

  async acceptRemoteAnswer(sdp: string): Promise<void> {
    if (!(await this.waitUntilStarted())) return;
    await NativeP2PCall.acceptRemoteAnswer({ sdp });
    this.hasRemoteDescription = true;
    await this.flushCandidates();
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.closed) return;
    if (!this.hasRemoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.sendCandidate(candidate);
  }

  setMicEnabled(enabled: boolean): void {
    if (this.closed) return;
    void NativeP2PCall.setMicEnabled({ enabled }).catch((err) =>
      console.error("[p2p] native setMicEnabled failed:", err),
    );
  }

  setRemoteVolume(percent: number): void {
    if (this.closed) return;
    void NativeP2PCall.setRemoteVolume({ volume: percent }).catch((err) =>
      console.error("[p2p] native setRemoteVolume failed:", err),
    );
  }

  async setVideoEnabled(enabled: boolean): Promise<boolean> {
    if (this.closed) return false;
    try {
      const result = await NativeP2PCall.setVideoEnabled({ enabled });
      this.events.onLocalVideo(result.enabled);
      return result.enabled;
    } catch (err) {
      console.error("[p2p] native setVideoEnabled failed:", err);
      return false;
    }
  }

  async switchCamera(): Promise<CameraFacing | null> {
    if (this.closed) return null;
    try {
      const { facing } = await NativeP2PCall.switchCamera();
      return facing;
    } catch (err) {
      console.error("[p2p] native switchCamera failed:", err);
      return null;
    }
  }

  async startScreenShare(): Promise<boolean> {
    return false;
  }

  stopScreenShare(): void {}

  /** The peer asked for a restart; it drives the same bounded loop as our own failures. */
  restartIce(): void {
    if (this.closed) return;
    this.recovery.start(true);
  }

  /** The key arrived after the call started (its accept confirmation came late). */
  setEndKey(endKey: string): void {
    if (this.closed) return;
    this.endKey = endKey;
    if ((!this.nativeStartRequested && !this.started) || !this.callId) return;
    void NativeP2PCall.setOwner({ callId: this.callId, endKey }).catch((err) =>
      console.error("[p2p] native setOwner failed:", err),
    );
  }

  resync(): void {
    if (this.closed || !this.started) return;
    void NativeP2PCall.currentCall()
      .then(({ callId }) => {
        if (this.closed) return;
        // Ended natively while the page was suspended (hung up on the lock screen, or the
        // connection died): the call is over here too.
        if (callId !== this.callId) {
          this.events.onConnectionLost();
          return;
        }
        this.resendOrRecover();
      })
      .catch((err) => console.error("[p2p] native currentCall failed:", err));
  }

  private resendOrRecover(): void {
    void NativeP2PCall.resendPendingOffer()
      .then(({ resent }) => {
        if (!resent && !this.closed && this.state !== "connected") this.recovery.start();
      })
      .catch((err) => console.error("[p2p] native resendPendingOffer failed:", err));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.recovery.dispose();
    this.pendingCandidates = [];
    for (const handle of this.handles) void handle.remove();
    this.handles.length = 0;
    void NativeP2PCall.closeCall().catch(() => {});
  }

  // ─── internals ───

  /** Removes a listener that finished attaching after close. */
  private async listen(pending: Promise<PluginListenerHandle>): Promise<void> {
    const handle = await pending;
    if (this.closed) void handle.remove();
    else this.handles.push(handle);
  }

  private async sendCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!candidate.candidate) return;
    await NativeP2PCall.addIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? undefined,
      sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
    });
  }

  private async flushCandidates(): Promise<void> {
    if (this.pendingCandidates.length === 0) return;
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      if (this.closed) return;
      // One bad candidate must not cost the ones after it.
      try {
        await this.sendCandidate(candidate);
      } catch (err) {
        console.warn("[p2p] Skipping a candidate the native side rejected:", err);
      }
    }
  }

  private onConnectionState(state: NativeConnectionState): void {
    if (this.closed) return;
    this.state = state;
    this.recovery.handleState(state);
  }
}
