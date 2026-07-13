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
  /**
   * iOS. Mark a call as answered so a later cancel VoIP push does not tear down the
   * call the user is already in — the server cancels the ring on accept, and that
   * cancel reaches the answering device too.
   */
  markAnswered(options: { call_id: string }): Promise<void>;
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

/** iOS-only; see markAnswered above. No-op elsewhere. */
export function markCallAnswered(callId: string): void {
  if (getCapacitorPlatform() !== "ios") return;
  // A failure here means the accept-time cancel push will end the call the user just
  // answered — loud, because there is no way to recover from it after the fact.
  void P2PCall.markAnswered({ call_id: callId }).catch((err) =>
    console.error("[p2p] failed to shield the answered call from the cancel push:", err),
  );
}
