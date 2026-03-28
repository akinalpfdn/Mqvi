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

/** Returns all active voice states (who is in which voice channel). */
export async function getVoiceStates(serverId: string) {
  return apiClient<VoiceState[]>(`/servers/${serverId}/voice/states`);
}
