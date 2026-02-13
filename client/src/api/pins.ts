/**
 * Pin API — Mesaj sabitleme endpoint'leri.
 *
 * getPins: Bir kanalın tüm pinlenmiş mesajlarını döner.
 * pinMessage: Bir mesajı sabitler (ManageMessages yetkisi gerekir).
 * unpinMessage: Bir mesajın pin'ini kaldırır (ManageMessages yetkisi gerekir).
 */

import { apiClient } from "./client";
import type { PinnedMessage } from "../types";

/** Bir kanalın tüm pinlenmiş mesajlarını getirir. */
export async function getPins(channelId: string) {
  return apiClient<PinnedMessage[]>(`/channels/${channelId}/pins`);
}

/** Bir mesajı sabitler. */
export async function pinMessage(channelId: string, messageId: string) {
  return apiClient<PinnedMessage>(
    `/channels/${channelId}/messages/${messageId}/pin`,
    { method: "POST" }
  );
}

/** Bir mesajın pin'ini kaldırır. */
export async function unpinMessage(channelId: string, messageId: string) {
  return apiClient<{ message: string }>(
    `/channels/${channelId}/messages/${messageId}/pin`,
    { method: "DELETE" }
  );
}
