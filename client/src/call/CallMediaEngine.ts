/**
 * CallMediaEngine — the media half of a p2p call, behind one interface.
 *
 * The store owns the call state machine (ringing, accepted, ended) and the signalling
 * transport; the engine owns the peer connection, the microphone, the camera and the
 * recovery loop. Two implementations: the WebView one (RTCPeerConnection, every platform
 * today) and the iOS one (native WebRTC), which exists because WKWebView cannot capture
 * audio while CallKit owns the audio session.
 *
 * Media stays peer to peer in both. The engine never talks to the server: it hands SDP and
 * ICE to the store, which signals them over the WebSocket the call already uses.
 */

import type { P2PCallType } from "../types";

export type CallDescription = { type: "offer" | "answer"; sdp: string };

export type CameraFacing = "front" | "back";

export type CallEngineEvents = {
  /** Local SDP is ready and must be signalled to the peer. */
  onLocalDescription(desc: CallDescription): void;
  /** A local ICE candidate is ready and must be signalled to the peer. */
  onIceCandidate(candidate: RTCIceCandidateInit): void;
  /** Remote media for the UI. Null on an engine that renders natively. */
  onRemoteStream(stream: MediaStream | null): void;
  /** Whether the peer is sending video. The only signal a natively-rendered call can give. */
  onRemoteVideo(available: boolean): void;
  /** Whether our own camera is publishing. A denied camera must not leave the button lit. */
  onLocalVideo(available: boolean): void;
  /** Local media for the self-preview. Null on an engine that renders natively. */
  onLocalStream(stream: MediaStream | null): void;
  /** This side cannot restart ICE itself (only the offerer can) and asks the peer to. */
  onIceRestartNeeded(): void;
  /** Screen sharing stopped outside the app's controls (the browser's own stop button). */
  onScreenShareEnded(): void;
  /** Recovery is exhausted — the call cannot be saved and must end. */
  onConnectionLost(): void;
};

export type CallEngineStart = {
  callId: string;
  callType: P2PCallType;
  /** The offerer drives negotiation and owns ICE restarts. */
  isCaller: boolean;
};

export interface CallMediaEngine {
  /**
   * True when the engine draws the video itself, outside the page. The call screen then keeps
   * its media area transparent and reports where the feeds belong instead of rendering them.
   */
  readonly rendersVideoNatively: boolean;

  /** Caller: acquires media and offers. Receiver: prepares, then waits for the offer. */
  start(opts: CallEngineStart): Promise<void>;
  /** A remote offer — initial or renegotiation. Answers through onLocalDescription. */
  acceptRemoteOffer(sdp: string): Promise<void>;
  acceptRemoteAnswer(sdp: string): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  setMicEnabled(enabled: boolean): void;
  /** Returns the camera state actually reached, so the store never claims more than happened. */
  setVideoEnabled(enabled: boolean): Promise<boolean>;
  /**
   * Flips between front and back camera. Returns where it ended up, or null when there is
   * nothing to flip — a desktop with one camera, or a call with the camera off.
   */
  switchCamera(): Promise<CameraFacing | null>;
  startScreenShare(): Promise<boolean>;
  stopScreenShare(): void;
  /** Offerer-side ICE restart, triggered by the peer's request. */
  restartIce(): void;
  /** Releases the microphone, camera and connection. Safe to call twice. */
  close(): void;
}
