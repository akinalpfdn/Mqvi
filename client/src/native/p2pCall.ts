/**
 * P2PCall — native incoming-call bridge.
 *
 * iOS (ios/App/App/P2PCallPlugin.swift): PushKit VoIP token + CallKit.
 * Android (android/.../P2PCallPlugin.kt): dismisses the ringing call notification.
 *
 * The two platforms expose different methods; call them through the helpers below,
 * which route by platform and no-op on web/Electron.
 */

import { registerPlugin } from "@capacitor/core";
import type { PluginListenerHandle } from "@capacitor/core";

import { getCapacitorPlatform } from "../utils/constants";

export interface P2PCallPlugin {
  /** iOS. Current VoIP (PushKit) token, "" if not yet available. */
  getVoipToken(): Promise<{ token: string }>;
  /** iOS. Dismiss the CallKit UI when the call ends/declines in-app. */
  endCall(options: { call_id: string }): Promise<void>;
  /** Android. Cancel the ringing incoming-call notification. */
  cancelIncomingCall(): Promise<void>;

  addListener(
    eventName: "voipToken",
    listener: (data: { token: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "callAnswered",
    listener: (data: { call_id: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "callEnded",
    listener: (data: { call_id: string }) => void,
  ): Promise<PluginListenerHandle>;
}

export const P2PCall = registerPlugin<P2PCallPlugin>("P2PCall");

/**
 * Stop the OS-level ring for a call this device is no longer taking — it was answered,
 * declined or ended on another of the user's devices. Called alongside the in-app
 * teardown; the server also sends a cancel push for devices with no live socket.
 */
export function dismissIncomingCallUI(callId: string): void {
  const platform = getCapacitorPlatform();
  if (platform === "ios") {
    void P2PCall.endCall({ call_id: callId }).catch((err) =>
      console.error("[p2p] failed to dismiss CallKit:", err),
    );
  } else if (platform === "android") {
    void P2PCall.cancelIncomingCall().catch((err) =>
      console.error("[p2p] failed to cancel the call notification:", err),
    );
  }
}

/**
 * The in-app overlay is now on screen, so it owns the ring — silence the OS notification that
 * was posted while the app was backgrounded. Android only: on iOS the CallKit UI IS the ring
 * and must stay up until the user answers or declines.
 *
 * "The overlay is showing" is the real signal. Cancelling on Activity resume instead would fire
 * on a cold start, long before the WebView and the socket are up, and a call the user opened the
 * app from the launcher to answer would go silent with nothing on screen.
 */
export function silenceAndroidCallRing(): void {
  if (getCapacitorPlatform() !== "android") return;
  void P2PCall.cancelIncomingCall().catch((err) =>
    console.error("[p2p] failed to cancel the call notification:", err),
  );
}

