/**
 * The media half of a p2p call. The store keeps the call state and signalling; media stays
 * peer to peer. Web runs RTCPeerConnection; iOS runs native WebRTC for CallKit's sake.
 */

import type { P2PCallType } from "../types";
import type { RecoveryConnectionState } from "./IceRecovery";

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
  /** The peer said goodbye over the media path; faster than the server, and it works while the
   * server cannot reach a suspended page. */
  onPeerHungUp(): void;
};

export type CallEngineStart = {
  callId: string;
  callType: P2PCallType;
  /** The offerer drives negotiation and owns ICE restarts. */
  isCaller: boolean;
  /** This side's key to hang up without the socket (the native layer, page suspended). */
  endKey?: string;
};

export type TakeOverCall = { callId: string; isCaller: boolean; state: RecoveryConnectionState };

export interface CallMediaEngine {
  /** The engine draws the video itself; the call screen only reports where the boxes are. */
  readonly rendersVideoNatively: boolean;

  /** Caller: acquires media and offers. Receiver: prepares, then waits for the offer. */
  start(opts: CallEngineStart): Promise<void>;
  /** A remote offer — initial or renegotiation. Answers through onLocalDescription. */
  acceptRemoteOffer(sdp: string): Promise<void>;
  acceptRemoteAnswer(sdp: string): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit): Promise<void>;
  setMicEnabled(enabled: boolean): void;
  /** The peer's volume, 0–200%. Only an engine that plays the audio itself applies it; the web
   * engine's audio goes through P2PAudioSink, which reads the store. */
  setRemoteVolume(percent: number): void;
  /** Returns the camera state actually reached, so the store never claims more than happened. */
  setVideoEnabled(enabled: boolean): Promise<boolean>;
  /** Returns where it ended up, or null when there is nothing to flip to. */
  switchCamera(): Promise<CameraFacing | null>;
  startScreenShare(): Promise<boolean>;
  stopScreenShare(): void;
  /** Offerer-side ICE restart, triggered by the peer's request. */
  restartIce(): void;
  /** This side's socketless hang-up key, when it arrives after the start. Unused on the web. */
  setEndKey(endKey: string): void;
  /**
   * Takes over a call a previous page ran, starting nothing: its media never stopped. Resolves
   * false where there is no such call to take (the web engine's media dies with its page).
   */
  takeOver(call: TakeOverCall): Promise<boolean>;
  /**
   * The socket was replaced, and whatever negotiation was in flight may have died with the old
   * one. Re-sends an unanswered offer, asks for an offer that never came, or recovers ICE.
   */
  resync(): void;
  /** Releases the microphone, camera and connection. Safe to call twice. */
  close(): void;
}
