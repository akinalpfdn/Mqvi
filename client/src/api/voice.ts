/**
 * Voice API fonksiyonları.
 *
 * Multi-server: Per-server LiveKit token generation.
 * Backend endpoint'leri:
 * - POST /api/servers/{serverId}/voice/token   → LiveKit JWT token oluşturur
 * - GET  /api/servers/{serverId}/voice/states  → Aktif ses durumlarını döner
 */

import { apiClient } from "./client";
import type { VoiceTokenResponse, VoiceState } from "../types";

/**
 * getVoiceToken — Ses kanalına katılmak için LiveKit JWT token alır.
 *
 * Multi-server: serverId ile hangi sunucunun LiveKit instance'ından
 * token alınacağı belirlenir. Backend credential'ları decrypt edip
 * token üretir — client LiveKit URL + token ile doğrudan bağlanır.
 */
export async function getVoiceToken(serverId: string, channelId: string) {
  return apiClient<VoiceTokenResponse>(`/servers/${serverId}/voice/token`, {
    method: "POST",
    body: { channel_id: channelId },
  });
}

/**
 * getVoiceStates — Tüm aktif ses durumlarını getirir.
 *
 * Kullanım: İlk bağlantı veya reconnect sonrası hangi kullanıcıların
 * hangi ses kanallarında olduğunu öğrenmek için.
 */
export async function getVoiceStates(serverId: string) {
  return apiClient<VoiceState[]>(`/servers/${serverId}/voice/states`);
}
