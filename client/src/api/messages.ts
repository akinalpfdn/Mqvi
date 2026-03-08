/**
 * Message API — server-scoped message CRUD.
 *
 * - GET    /api/servers/{serverId}/channels/{id}/messages  — cursor-based pagination
 * - POST   /api/servers/{serverId}/channels/{id}/messages  — send message (JSON or multipart)
 * - PATCH  /api/servers/{serverId}/messages/{id}           — edit message
 * - DELETE /api/servers/{serverId}/messages/{id}           — delete message
 */

import { apiClient } from "./client";
import type { Message, MessagePage } from "../types";
import { API_BASE_URL } from "../utils/constants";

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
 * Sends a new message. Uses multipart/form-data when files are attached,
 * JSON otherwise. Browser sets Content-Type automatically for FormData.
 */
export async function sendMessage(
  serverId: string,
  channelId: string,
  content: string,
  files?: File[],
  replyToId?: string
) {
  if (files && files.length > 0) {
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

  return apiClient<Message>(`/servers/${serverId}/channels/${channelId}/messages`, {
    method: "POST",
    body: { content, reply_to_id: replyToId },
  });
}

/**
 * Sends an E2EE channel message. Ciphertext is a JSON-serialized SenderKeyMessage.
 * Uses multipart when encrypted files are attached.
 */
export async function sendEncryptedMessage(
  serverId: string,
  channelId: string,
  ciphertext: string,
  senderDeviceId: string,
  metadata: string,
  files?: File[],
  replyToId?: string
) {
  if (files && files.length > 0) {
    const formData = new FormData();
    formData.append("encryption_version", "1");
    formData.append("ciphertext", ciphertext);
    formData.append("sender_device_id", senderDeviceId);
    formData.append("e2ee_metadata", metadata);
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

  return apiClient<Message>(`/servers/${serverId}/channels/${channelId}/messages`, {
    method: "POST",
    body: {
      encryption_version: 1,
      ciphertext,
      sender_device_id: senderDeviceId,
      e2ee_metadata: metadata,
      ...(replyToId ? { reply_to_id: replyToId } : {}),
    },
  });
}

/** Edits an E2EE channel message. */
export function editEncryptedMessage(
  serverId: string,
  messageId: string,
  ciphertext: string,
  senderDeviceId: string,
  metadata: string
) {
  return apiClient<Message>(`/servers/${serverId}/messages/${messageId}`, {
    method: "PATCH",
    body: {
      encryption_version: 1,
      ciphertext,
      sender_device_id: senderDeviceId,
      e2ee_metadata: metadata,
    },
  });
}

/** Edits a message (owner only). */
export async function editMessage(serverId: string, messageId: string, content: string) {
  return apiClient<Message>(`/servers/${serverId}/messages/${messageId}`, {
    method: "PATCH",
    body: { content },
  });
}

/** Deletes a message (owner or MANAGE_MESSAGES permission). */
export async function deleteMessage(serverId: string, messageId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/messages/${messageId}`, {
    method: "DELETE",
  });
}

/** Returns the full upload URL for an attachment. */
export function getUploadUrl(fileUrl: string): string {
  if (fileUrl.startsWith("/api/")) {
    return fileUrl;
  }
  return `${API_BASE_URL}/uploads/${fileUrl}`;
}
