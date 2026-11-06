/**
 * Voice API — per-server LiveKit token generation and voice state.
 */

import { apiClient } from "./client";
import type { MicReport } from "../audio/micHealth";
import type { VoiceTokenResponse, VoiceState } from "../types";
import type { NativeEngine, PublishEngine } from "../utils/publishEngine";

/**
 * Gets a LiveKit JWT token for joining a voice channel.
 * Backend decrypts the server's LiveKit credentials and generates the token.
 */
export async function getVoiceToken(serverId: string, channelId: string) {
  return apiClient<VoiceTokenResponse>(`/servers/${serverId}/voice/token`, {
    method: "POST",
    body: { channel_id: channelId },
  });
}

/**
 * Gets a LiveKit JWT token for iOS native screen share.
 * The token uses a "{userId}_ss" identity so it can join the same room
 * as a separate participant that only publishes the screen share track.
 */
export async function getScreenShareToken(serverId: string, channelId: string) {
  return apiClient<VoiceTokenResponse>(`/servers/${serverId}/voice/screen-token`, {
    method: "POST",
    body: { channel_id: channelId },
  });
}

/**
 * Why the native helper could not start. A closed set — the server rejects anything else.
 *
 * No "unsupported": the helper is only tried where it can run, so a platform that cannot do it
 * never reports a fallback because it never attempted one.
 */
export type ScreenShareFallbackReason = "no_token" | "helper_failed";

/**
 * Tells the server that a helper engine failed and the browser path was used instead.
 *
 * Everything that can fail there fails on this machine, so the server has no other way to know it
 * happened — and the people it happens to cannot be asked to fetch a log. Fire-and-forget: the
 * share is already running either way.
 */
export async function reportScreenShareFallback(
  serverId: string,
  channelId: string,
  engine: NativeEngine,
  reason: ScreenShareFallbackReason,
  detail?: string
) {
  return apiClient<void>(`/servers/${serverId}/voice/screen-share-fallback`, {
    method: "POST",
    body: { channel_id: channelId, engine, reason, detail },
  });
}

/** Every engine a share can run on: the desktop's three, and the phone's native capture. */
export type StopReportEngine = PublishEngine | "mobile";

/** How a share ended without the stop button, on any engine. Mirrors the server's closed set. */
export type ScreenShareStopReason = "start_failed" | "track_ended" | "unpublished" | "helper_exited";

/**
 * Tells the server a share ended without the stop button, on which engine, and after how long.
 * Like the fallback report, every cause lives on this machine, so this is the only way it is ever
 * seen. The server decides which of these are failures. Fire-and-forget.
 */
export async function reportScreenShareStop(
  serverId: string,
  channelId: string,
  engine: StopReportEngine,
  reason: ScreenShareStopReason,
  aliveMs: number,
  detail?: string
) {
  return apiClient<void>(`/servers/${serverId}/voice/screen-share-stopped`, {
    method: "POST",
    body: { channel_id: channelId, engine, reason, alive_ms: Math.max(0, Math.round(aliveMs)), detail },
  });
}

/** Which denoiser was being attached when it failed. Mirrors the server's closed set. */
export type NoiseReductionEngine = "rnnoise" | "gtcrn" | "vadgate";

/**
 * Why it failed. `unsupported_sample_rate` is the known one — GTCRN's model runs at 16 kHz and its
 * worklet accepts only 16/48 kHz, and the device's rate is not ours to choose. `attach_failed` is
 * everything else, and is the more serious of the two: the user has no denoising at all.
 */
export type NoiseReductionFailureReason = "unsupported_sample_rate" | "attach_failed";

/**
 * Tells the server the mic denoiser would not attach.
 *
 * A screen share that fails is at least visible to the person sharing. A denoiser that never
 * attached is visible to nobody: the user simply sounds noisy and concludes the feature is weak.
 * Before this the only trace was a console.error nobody reads in a packaged app.
 *
 * Fire-and-forget — the call carries on regardless, the person is just unfiltered.
 */
export async function reportNoiseReductionFailure(
  serverId: string,
  channelId: string,
  engine: NoiseReductionEngine,
  reason: NoiseReductionFailureReason,
  detail?: string
) {
  return apiClient<void>(`/servers/${serverId}/voice/noise-reduction-failure`, {
    method: "POST",
    body: { channel_id: channelId, engine, reason, detail },
  });
}

/** Where the reporting client runs. Mirrors the server's closed set; the iOS app's voice is native. */
export type MicPlatform = "electron_mac" | "electron_windows" | "electron_linux" | "web" | "android";

/** The processor on the mic when the report was made. Mirrors the server's closed set. */
export type MicProcessorKind = "none" | "rnnoise" | "gtcrn" | "vadgate";

export type MicHealthBody = MicReport & {
  channel_id: string;
  platform: MicPlatform;
  processor: MicProcessorKind;
  app_version: string;
};

/**
 * Tells the server the microphone died, or how that ended (see audio/micHealth). Fire-and-forget:
 * the report is for the operator, and nothing the user does waits on it.
 */
export async function reportMicHealth(serverId: string, body: MicHealthBody) {
  return apiClient<void>(`/servers/${serverId}/voice/mic-health`, {
    method: "POST",
    body: {
      channel_id: body.channel_id,
      event: body.event,
      fault: body.fault,
      faults: body.faults,
      intent: body.intent,
      platform: body.platform,
      processor: body.processor,
      app_version: body.app_version,
      duration_ms: Math.max(0, Math.round(body.durationMs)),
      since_reconnect_ms: Math.round(body.sinceReconnectMs),
      trail: body.trail.map((t) => ({ e: t.e, ago_ms: Math.max(0, Math.round(t.ago_ms)) })),
      detail: body.detail,
    },
  });
}

/** Returns all active voice states (who is in which voice channel). */
export async function getVoiceStates(serverId: string) {
  return apiClient<VoiceState[]>(`/servers/${serverId}/voice/states`);
}
