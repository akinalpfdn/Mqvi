/**
 * DM API — Direct Messages endpoint'leri.
 *
 * listDMChannels: Kullanıcının tüm DM kanallarını listeler.
 * createDMChannel: İki kullanıcı arasında DM kanalı oluşturur/bulur.
 * getDMMessages: Cursor-based pagination ile DM mesajlarını getirir.
 * sendDMMessage: Yeni DM mesajı gönderir.
 * editDMMessage: DM mesajını düzenler.
 * deleteDMMessage: DM mesajını siler.
 */

import { apiClient } from "./client";
import type { DMChannelWithUser, DMMessagePage, DMMessage } from "../types";

export function listDMChannels() {
  return apiClient<DMChannelWithUser[]>("/dms");
}

export function createDMChannel(userId: string) {
  return apiClient<DMChannelWithUser>("/dms", {
    method: "POST",
    body: { user_id: userId },
  });
}

export function getDMMessages(channelId: string, before?: string, limit = 50) {
  const params = new URLSearchParams();
  if (before) params.set("before", before);
  params.set("limit", String(limit));
  return apiClient<DMMessagePage>(`/dms/${channelId}/messages?${params}`);
}

export function sendDMMessage(channelId: string, content: string) {
  return apiClient<DMMessage>(`/dms/${channelId}/messages`, {
    method: "POST",
    body: { content },
  });
}

export function editDMMessage(messageId: string, content: string) {
  return apiClient<DMMessage>(`/dms/messages/${messageId}`, {
    method: "PATCH",
    body: { content },
  });
}

export function deleteDMMessage(messageId: string) {
  return apiClient<{ message: string }>(`/dms/messages/${messageId}`, {
    method: "DELETE",
  });
}
