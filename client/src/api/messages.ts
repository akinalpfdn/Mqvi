/**
 * Message API fonksiyonları.
 *
 * Multi-server: Tüm endpoint'ler server-scoped.
 * Backend endpoint'leri:
 * - GET    /api/servers/{serverId}/channels/{id}/messages  → Mesajları cursor-based pagination ile döner
 * - POST   /api/servers/{serverId}/channels/{id}/messages  → Yeni mesaj gönder (JSON veya multipart)
 * - PATCH  /api/servers/{serverId}/messages/{id}           → Mesajı düzenle
 * - DELETE /api/servers/{serverId}/messages/{id}           → Mesajı sil
 */

import { apiClient } from "./client";
import type { Message, MessagePage } from "../types";
import { API_BASE_URL } from "../utils/constants";

/**
 * Mesajları cursor-based pagination ile getirir.
 *
 * @param serverId - Sunucu ID'si
 * @param channelId - Kanal ID'si
 * @param before - Bu ID'den önceki mesajları getir (boşsa en yenilerden başla)
 * @param limit - Kaç mesaj dönsün (default 50, max 100)
 */
export async function getMessages(
  serverId: string,
  channelId: string,
  before?: string,
  limit?: number
) {
  const params = new URLSearchParams();
  if (before) params.set("before", before);
  if (limit) params.set("limit", limit.toString());

  const query = params.toString();
  const endpoint = `/servers/${serverId}/channels/${channelId}/messages${query ? `?${query}` : ""}`;

  return apiClient<MessagePage>(endpoint);
}

/**
 * Yeni mesaj gönderir.
 *
 * Dosya varsa multipart/form-data, yoksa JSON gönderir.
 * FormData kullanıldığında Content-Type header'ı browser tarafından
 * otomatik ayarlanır (boundary dahil). Manuel set etmek HATALI olur.
 */
export async function sendMessage(
  serverId: string,
  channelId: string,
  content: string,
  files?: File[],
  replyToId?: string
) {
  if (files && files.length > 0) {
    // Multipart: dosya + metin
    const formData = new FormData();
    formData.append("content", content);
    if (replyToId) {
      formData.append("reply_to_id", replyToId);
    }
    for (const file of files) {
      formData.append("files", file);
    }

    return apiClient<Message>(`/servers/${serverId}/channels/${channelId}/messages`, {
      method: "POST",
      body: formData,
    });
  }

  // JSON: sadece metin (+ opsiyonel reply)
  return apiClient<Message>(`/servers/${serverId}/channels/${channelId}/messages`, {
    method: "POST",
    body: { content, reply_to_id: replyToId },
  });
}

/** Mesajı düzenler (sadece mesaj sahibi) */
export async function editMessage(serverId: string, messageId: string, content: string) {
  return apiClient<Message>(`/servers/${serverId}/messages/${messageId}`, {
    method: "PATCH",
    body: { content },
  });
}

/** Mesajı siler (mesaj sahibi veya MANAGE_MESSAGES yetkisi) */
export async function deleteMessage(serverId: string, messageId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/messages/${messageId}`, {
    method: "DELETE",
  });
}

/**
 * Upload URL'sini döner — attachment gösterimi için.
 * Backend'de statik dosya servisi: GET /api/uploads/{filename}
 */
export function getUploadUrl(fileUrl: string): string {
  // file_url zaten "/api/uploads/..." formatında geliyorsa direkt kullan
  if (fileUrl.startsWith("/api/")) {
    return fileUrl;
  }
  return `${API_BASE_URL}/uploads/${fileUrl}`;
}
