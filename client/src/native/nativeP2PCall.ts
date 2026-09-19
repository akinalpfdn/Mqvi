/** Bridge to NativeP2PCallPlugin.swift, which runs the media; the store keeps the call. */

import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";

import { getCapacitorPlatform } from "../utils/constants";

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
    /** This page's instance, so a reload can hang the call up in its name. */
    instanceId: string;
    isCaller: boolean;
    callType: "voice" | "video";
    iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  }): Promise<{ video: boolean }>;
  acceptRemoteOffer(options: { sdp: string }): Promise<void>;
  acceptRemoteAnswer(options: { sdp: string }): Promise<void>;
  addIceCandidate(options: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }): Promise<void>;
  setMicEnabled(options: { enabled: boolean }): Promise<void>;
  setRemoteVolume(options: { volume: number }): Promise<void>;
  setVideoEnabled(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
  switchCamera(): Promise<{ facing: "front" | "back" }>;
  /** Where the two feeds belong, in CSS pixels of the web view. */
  setVideoLayout(options: {
    /** The call area both feeds are bounded by, the way the page clips them to it. */
    clip: NativeVideoRect | null;
    /** What the page draws over the feeds; cut out of the video so it shows through. */
    holes: NativeVideoRect[];
    remote: NativeVideoRect | null;
    local: NativeVideoRect | null;
    cornerRadius: number;
    mirrorLocal: boolean;
  }): Promise<void>;
  hideVideo(): Promise<void>;
  /** Latest pixel size per feed, for a subscriber that arrives after the first frame. */
  getVideoSizes(): Promise<Partial<Record<NativeVideoSize["source"], { width: number; height: number }>>>;
  setIceServers(options: {
    iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  }): Promise<void>;
  restartIce(): Promise<void>;
  /** Sends our offer again if it is still unanswered. */
  resendPendingOffer(): Promise<{ resent: boolean }>;
  closeCall(): Promise<void>;
  /** Ends a call a previous page left running. See discardOrphanedNativeCall. */
  discardOrphanedCall(): Promise<{ discarded: boolean; callId?: string; instanceId?: string }>;
  /** The call the native side still runs, if any. */
  currentCall(): Promise<{ callId: string | null }>;
  /** A call a previous page left running with live media, for this page to take over. */
  adoptableCall(): Promise<AdoptableCall | { callId: null }>;

  // Call events carry their call id; the plugin's listeners outlive any one call.
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
  /** Our camera stopped (it failed to start); the call no longer has a picture of ours. */
  addListener(
    eventName: "localVideo",
    listener: (data: { callId: string; available: boolean }) => void,
  ): Promise<PluginListenerHandle>;
  /** A feed's pixel shape, so the page can give a natively drawn box the right aspect ratio. */
  addListener(
    eventName: "videoSize",
    listener: (data: NativeVideoSize) => void,
  ): Promise<PluginListenerHandle>;
};

export type AdoptableCall = {
  callId: string;
  /** The page instance that ran it; the server hands the call over only in its name. */
  instanceId?: string;
  isCaller: boolean;
  state: NativeConnectionState;
  micEnabled: boolean;
  videoEnabled: boolean;
  facing: "front" | "back";
  remoteVideo: boolean;
  volume: number;
  /** CallKit shows it, so hanging up in the app must take that screen down too. */
  inCallKit: boolean;
};

export const NativeP2PCall = registerPlugin<NativeP2PCallPlugin>("NativeP2PCall");

/**
 * Run at boot: a reload keeps the native plugin, so a call the old page ran (or was starting)
 * is ended here. Native only closes an audio session it opened itself.
 */
/** A call the old page left running whose media is still alive, or null. iOS only. */
export async function findAdoptableNativeCall(): Promise<AdoptableCall | null> {
  if (getCapacitorPlatform() !== "ios") return null;
  try {
    const call = await NativeP2PCall.adoptableCall();
    return call.callId ? (call as AdoptableCall) : null;
  } catch (err) {
    console.error("[p2p] checking for a call to take over failed:", err);
    return null;
  }
}

export async function discardOrphanedNativeCall(): Promise<{ callId: string; instanceId?: string } | null> {
  if (getCapacitorPlatform() !== "ios") return null;
  try {
    const { callId, instanceId } = await NativeP2PCall.discardOrphanedCall();
    return callId ? { callId, instanceId } : null;
  } catch (err) {
    console.error("[p2p] discarding an orphaned native call failed:", err);
    return null;
  }
}
