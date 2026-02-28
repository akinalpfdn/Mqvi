/**
 * Pin API — Mesaj sabitleme endpoint'leri.
 *
 * Multi-server: Tüm endpoint'ler server-scoped.
 * getPins: Bir kanalın tüm pinlenmiş mesajlarını döner.
 * pinMessage: Bir mesajı sabitler (ManageMessages yetkisi gerekir).
 * unpinMessage: Bir mesajın pin'ini kaldırır (ManageMessages yetkisi gerekir).
 */

import { apiClient } from "./client";
import type { PinnedMessage } from "../types";

/** Bir kanalın tüm pinlenmiş mesajlarını getirir. */
export async function getPins(serverId: string, channelId: string) {
  return apiClient<PinnedMessage[]>(`/servers/${serverId}/channels/${channelId}/pins`);
}

/** Bir mesajı sabitler. */
export async function pinMessage(serverId: string, channelId: string, messageId: string) {
  return apiClient<PinnedMessage>(
    `/servers/${serverId}/channels/${channelId}/messages/${messageId}/pin`,
    { method: "POST" }
  );
}

/** Bir mesajın pin'ini kaldırır. */
export async function unpinMessage(serverId: string, channelId: string, messageId: string) {
  return apiClient<{ message: string }>(
    `/servers/${serverId}/channels/${channelId}/messages/${messageId}/pin`,
    { method: "DELETE" }
  );
}
