/**
 * Reaction API — server-scoped emoji reaction toggle.
 *
 * POST /api/servers/{serverId}/messages/{messageId}/reactions
 * Body: { "emoji": "..." }
 *
 * Emoji is sent in body (not URL path) to avoid encoding issues with Vite proxy.
 */

import { apiClient } from "./client";

/** Toggles an emoji reaction on a message (adds if absent, removes if present). */
export async function toggleReaction(serverId: string, messageId: string, emoji: string) {
  return apiClient<{ message: string }>(
    `/servers/${serverId}/messages/${messageId}/reactions`,
    { method: "POST", body: { emoji } }
  );
}
