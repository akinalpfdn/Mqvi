/**
 * Reaction API fonksiyonları.
 *
 * Multi-server: server-scoped endpoint.
 * Backend endpoint:
 * - POST /api/servers/{serverId}/messages/{messageId}/reactions → Toggle reaction (ekle veya kaldır)
 *   Body: { "emoji": "👍" }
 */

import { apiClient } from "./client";

/**
 * toggleReaction — Bir mesaja emoji reaction ekler veya kaldırır.
 *
 * Toggle pattern: Aynı emoji ile tekrar çağrılırsa reaction kaldırılır.
 * Backend UNIQUE constraint (message_id, user_id, emoji) ile bunu garanti eder.
 *
 * Emoji URL path'te encoding sorunları yaratabileceği için body'de gönderilir.
 *
 * @param serverId - Sunucu ID'si (multi-server scope)
 * @param messageId - Reaction eklenecek mesajın ID'si
 * @param emoji - Emoji karakteri (ör. "👍", "❤️", "😂")
 */
export async function toggleReaction(serverId: string, messageId: string, emoji: string) {
  return apiClient<{ message: string }>(
    `/servers/${serverId}/messages/${messageId}/reactions`,
    { method: "POST", body: { emoji } }
  );
}
