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
    iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  }): Promise<void>;
  acceptRemoteOffer(options: { sdp: string }): Promise<void>;
  acceptRemoteAnswer(options: { sdp: string }): Promise<void>;
  addIceCandidate(options: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }): Promise<void>;
  setMicEnabled(options: { enabled: boolean }): Promise<void>;
  setIceServers(options: {
    iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  }): Promise<void>;
  restartIce(): Promise<void>;
  closeCall(): Promise<void>;

  addListener(
    eventName: "localDescription",
    listener: (data: { type: "offer" | "answer"; sdp: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "iceCandidate",
    listener: (data: NativeIceCandidate) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "connectionState",
    listener: (data: { state: NativeConnectionState }) => void,
  ): Promise<PluginListenerHandle>;
};

export const NativeP2PCall = registerPlugin<NativeP2PCallPlugin>("NativeP2PCall");
