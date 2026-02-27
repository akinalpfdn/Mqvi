/**
 * DM API — Direct Messages endpoint'leri.
 *
 * Mesaj:
 *   listDMChannels: Kullanıcının tüm DM kanallarını listeler.
 *   createDMChannel: İki kullanıcı arasında DM kanalı oluşturur/bulur.
 *   getDMMessages: Cursor-based pagination ile DM mesajlarını getirir.
 *   sendDMMessage: Yeni DM mesajı gönderir (JSON veya multipart/form-data).
 *   editDMMessage: DM mesajını düzenler.
 *   deleteDMMessage: DM mesajını siler.
 *
 * Reaction:
 *   toggleDMReaction: DM mesajına emoji tepkisi ekle/kaldır (toggle).
 *
 * Pin:
 *   pinDMMessage: DM mesajını sabitle.
 *   unpinDMMessage: DM mesajının sabitlemesini kaldır.
 *   getDMPinnedMessages: DM kanalının sabitlenmiş mesajlarını listele.
 *
 * Search:
 *   searchDMMessages: DM kanalında FTS5 tam metin araması.
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

/**
 * Yeni DM mesajı gönderir.
 *
 * Channel sendMessage ile aynı pattern:
 * - Dosya varsa multipart/form-data (FormData), yoksa JSON
 * - FormData kullanıldığında Content-Type browser tarafından ayarlanır
 * - reply_to_id opsiyonel — yanıt mesajı için
 */
export async function sendDMMessage(
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

    return apiClient<DMMessage>(`/dms/${channelId}/messages`, {
      method: "POST",
      body: formData,
    });
  }

  // JSON: sadece metin (+ opsiyonel reply)
  return apiClient<DMMessage>(`/dms/${channelId}/messages`, {
    method: "POST",
    body: {
      content,
      ...(replyToId ? { reply_to_id: replyToId } : {}),
    },
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

// ─── Reaction ───

/**
 * DM mesajına emoji tepkisi ekle/kaldır (toggle).
 * Emoji zaten varsa kaldırılır, yoksa eklenir.
 */
export function toggleDMReaction(messageId: string, emoji: string) {
  return apiClient<{ status: string }>(`/dms/messages/${messageId}/reactions`, {
    method: "POST",
    body: { emoji },
  });
}

// ─── Pin ───

export function pinDMMessage(messageId: string) {
  return apiClient<{ status: string }>(`/dms/messages/${messageId}/pin`, {
    method: "POST",
  });
}

export function unpinDMMessage(messageId: string) {
  return apiClient<{ status: string }>(`/dms/messages/${messageId}/pin`, {
    method: "DELETE",
  });
}

export function getDMPinnedMessages(channelId: string) {
  return apiClient<DMMessage[]>(`/dms/${channelId}/pinned`);
}

// ─── Search ───

/** DM arama sonucu tipi — mesajlar + toplam sayı (pagination için). */
export type DMSearchResult = {
  messages: DMMessage[];
  total_count: number;
};

/**
 * DM kanalında FTS5 tam metin araması yapar.
 * Channel searchMessages ile aynı pattern — limit/offset ile pagination destekler.
 */
export function searchDMMessages(channelId: string, query: string, limit = 25, offset = 0) {
  const params = new URLSearchParams({ q: query });
  if (limit !== 25) params.set("limit", String(limit));
  if (offset > 0) params.set("offset", String(offset));
  return apiClient<DMSearchResult>(`/dms/${channelId}/search?${params}`);
}
