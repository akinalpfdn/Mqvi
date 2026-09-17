/**
 * NativeCallEngine — the iOS media engine. Same contract as the WebView one, but the peer
 * connection, the microphone and the audio output all live in the native plugin.
 *
 * Why it exists: measured on device, a call answered from the CallKit screen shows the green
 * system call indicator and no orange microphone indicator — WKWebView never gets the mic
 * while CallKit owns the audio session, so the call connects and stays silent both ways.
 *
 * Audio only for now. A video call still runs on the web engine until the native render
 * layer lands, so this engine is chosen per call type.
 */

import { fetchIceServers } from "../api/calls";
import { NativeP2PCall, type NativeConnectionState } from "../native/nativeP2PCall";
import type { PluginListenerHandle } from "@capacitor/core";
import type {
  CallEngineEvents,
  CallEngineStart,
  CallMediaEngine,
  CameraFacing,
} from "./CallMediaEngine";
import { DISCONNECT_GRACE_MS, IceRecovery } from "./IceRecovery";

export class NativeCallEngine implements CallMediaEngine {
  readonly rendersVideoNatively = true;

  private readonly events: CallEngineEvents;
  private readonly handles: PluginListenerHandle[] = [];

  private started = false;
  private closed = false;
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
      // The native side does not surface the signalling state, so every disconnect gets the
      // shorter window. A renegotiation in flight is the rarer case and it still recovers,
      // just one attempt sooner.
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

  async start(opts: CallEngineStart): Promise<void> {
    if (this.closed) return;

    this.handles.push(
      await NativeP2PCall.addListener("localDescription", (desc) => {
        if (!this.closed) this.events.onLocalDescription(desc);
      }),
    );
    this.handles.push(
      await NativeP2PCall.addListener("iceCandidate", (candidate) => {
        if (this.closed) return;
        this.events.onIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid || null,
          sdpMLineIndex: candidate.sdpMLineIndex,
        });
      }),
    );
    this.handles.push(
      await NativeP2PCall.addListener("connectionState", ({ state }) => {
        this.onConnectionState(state);
      }),
    );
    this.handles.push(
      await NativeP2PCall.addListener("remoteVideo", ({ available }) => {
        if (!this.closed) this.events.onRemoteVideo(available);
      }),
    );

    if (this.closed) return;
    const iceServers = await fetchIceServers();
    if (this.closed) return;

    this.isCaller = opts.isCaller;
    const { video } = await NativeP2PCall.start({
      callId: opts.callId,
      isCaller: opts.isCaller,
      callType: opts.callType,
      iceServers: iceServers.map((server) => ({
        urls: server.urls,
        username: server.username,
        credential: typeof server.credential === "string" ? server.credential : undefined,
      })),
    });
    this.started = true;
    // A video call publishes the camera from the start; the button has to know that, and it
    // has to know when a denied camera means it did not.
    this.events.onLocalVideo(video);
  }

  async acceptRemoteOffer(sdp: string): Promise<void> {
    if (this.closed || !this.started) return;
    await NativeP2PCall.acceptRemoteOffer({ sdp });
    this.hasRemoteDescription = true;
    await this.flushCandidates();
  }

  async acceptRemoteAnswer(sdp: string): Promise<void> {
    if (this.closed || !this.started) return;
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
    this.recovery.start();
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
      await this.sendCandidate(candidate);
    }
  }

  private onConnectionState(state: NativeConnectionState): void {
    if (this.closed) return;
    this.state = state;
    this.recovery.handleState(state);
  }
}
