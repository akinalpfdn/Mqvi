/**
 * Voice API fonksiyonları.
 *
 * Backend endpoint'leri:
 * - POST /api/voice/token   → LiveKit JWT token oluşturur (ses kanalına katılım için)
 * - GET  /api/voice/states  → Tüm aktif ses durumlarını döner
 */

import { apiClient } from "./client";
import type { VoiceTokenResponse, VoiceState } from "../types";

/**
 * getVoiceToken — Ses kanalına katılmak için LiveKit JWT token alır.
 *
 * Backend bu token'ı oluştururken şu kontrolleri yapar:
 * 1. Kanal var mı ve voice tipinde mi?
 * 2. PermConnectVoice yetkisi var mı?
 * 3. Kanal dolu mu? (user_limit kontrolü)
 * 4. PermSpeak → canPublish grant (ses yayını)
 * 5. PermStream → screen share izni
 */
export async function getVoiceToken(channelId: string) {
  return apiClient<VoiceTokenResponse>("/voice/token", {
    method: "POST",
    body: { channel_id: channelId },
  });
}

/**
 * getVoiceStates — Tüm aktif ses durumlarını getirir.
 *
 * Kullanım: İlk bağlantı veya reconnect sonrası hangi kullanıcıların
 * hangi ses kanallarında olduğunu öğrenmek için.
 * Normal akışta WS voice_states_sync event'i bunu zaten sağlar.
 */
export async function getVoiceStates() {
  return apiClient<VoiceState[]>("/voice/states");
}
