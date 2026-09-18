/**
 * Bridge to the native peer connection (ios/App/App/NativeP2PCallPlugin.swift).
 *
 * The call itself stays where it was: the store drives it and signals SDP and ICE over the
 * WebSocket. Only the media engine lives natively, because WKWebView cannot capture the
 * microphone while CallKit owns the audio session.
 */

import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type NativeIceCandidate = {
  candidate: string;
  sdpMid: string;
  sdpMLineIndex: number;
};

export type NativeVideoRect = { x: number; y: number; width: number; height: number };

export type NativeVideoSize = {
  source: "remote" | "local";
  width: number;
  height: number;
};

export type NativeConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed"
  | "unknown";

type NativeP2PCallPlugin = {
  start(options: {
    callId: string;
    isCaller: boolean;
    callType: "voice" | "video";
    iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  }): Promise<{ video: boolean }>;
  acceptRemoteOffer(options: { sdp: string }): Promise<void>;
  acceptRemoteAnswer(options: { sdp: string }): Promise<void>;
  addIceCandidate(options: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }): Promise<void>;
  setMicEnabled(options: { enabled: boolean }): Promise<void>;
  setVideoEnabled(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
  switchCamera(): Promise<{ facing: "front" | "back" }>;
  /** Where the two feeds belong, in CSS pixels of the web view. */
  setVideoLayout(options: {
    /** The call area both feeds are bounded by, the way the page clips them to it. */
    clip: NativeVideoRect | null;
    remote: NativeVideoRect | null;
    local: NativeVideoRect | null;
    cornerRadius: number;
    mirrorLocal: boolean;
  }): Promise<void>;
  hideVideo(): Promise<void>;
  setIceServers(options: {
    iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  }): Promise<void>;
  restartIce(): Promise<void>;
  closeCall(): Promise<void>;

  // Call events name the call they belong to. The native side already drops events from a
  // connection it has let go of; the engine checks the id as well, since the plugin's
  // listeners outlive any one call.
  addListener(
    eventName: "localDescription",
    listener: (data: { callId: string; type: "offer" | "answer"; sdp: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "iceCandidate",
    listener: (data: NativeIceCandidate & { callId: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "connectionState",
    listener: (data: { callId: string; state: NativeConnectionState }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "remoteVideo",
    listener: (data: { callId: string; available: boolean }) => void,
  ): Promise<PluginListenerHandle>;
  /** A feed's pixel shape, so the page can give a natively drawn box the right aspect ratio. */
  addListener(
    eventName: "videoSize",
    listener: (data: NativeVideoSize) => void,
  ): Promise<PluginListenerHandle>;
};

export const NativeP2PCall = registerPlugin<NativeP2PCallPlugin>("NativeP2PCall");
