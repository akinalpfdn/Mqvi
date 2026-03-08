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

/** Returns all active voice states (who is in which voice channel). */
export async function getVoiceStates(serverId: string) {
  return apiClient<VoiceState[]>(`/servers/${serverId}/voice/states`);
}
