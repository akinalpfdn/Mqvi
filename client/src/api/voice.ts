/**
 * Voice API — per-server LiveKit token generation and voice state.
 */

import { apiClient } from "./client";
import type { VoiceTokenResponse, VoiceState } from "../types";

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
 * Why "Akıcı Görüntü" could not start. A closed set — the server rejects anything else.
 *
 * No "unsupported": the picker only offers smooth where it can run, so a platform that cannot do
 * it never reports a fallback because it never attempted one.
 */
export type ScreenShareFallbackReason = "no_token" | "helper_failed";

/**
 * Tells the server that smooth capture failed and the browser path was used instead.
 *
 * Everything that can fail there fails on this machine, so the server has no other way to know it
 * happened — and the people it happens to cannot be asked to fetch a log. Fire-and-forget: the
 * share is already running either way.
 */
export async function reportScreenShareFallback(
  serverId: string,
  channelId: string,
  reason: ScreenShareFallbackReason,
  detail?: string
) {
  return apiClient<void>(`/servers/${serverId}/voice/screen-share-fallback`, {
    method: "POST",
    body: { channel_id: channelId, reason, detail },
  });
}

/** Returns all active voice states (who is in which voice channel). */
export async function getVoiceStates(serverId: string) {
  return apiClient<VoiceState[]>(`/servers/${serverId}/voice/states`);
}
