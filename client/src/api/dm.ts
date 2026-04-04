/**
 * DM API — Direct Messages endpoints.
 *
 * Message: list, create, get, send, edit, delete DM channels/messages.
 * Reaction: toggle emoji reaction on DM messages.
 * Pin: pin/unpin DM messages.
 * Search: FTS5 full-text search within DM channels.
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
 * Sends a DM message. Uses multipart/form-data when files are attached, JSON otherwise.
 * Browser sets Content-Type automatically for FormData (including boundary).
 */
export async function sendDMMessage(
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

    return apiClient<DMMessage>(`/dms/${channelId}/messages`, {
      method: "POST",
      body: formData,
    });
  }

  return apiClient<DMMessage>(`/dms/${channelId}/messages`, {
    method: "POST",
    body: {
      content,
      ...(replyToId ? { reply_to_id: replyToId } : {}),
    },
  });
}

/**
 * Sends an E2EE DM message. Ciphertext is a JSON-serialized EncryptedEnvelope[] array,
 * each envelope encrypted separately per recipient device.
 * Uses multipart when encrypted files are attached.
 */
export async function sendEncryptedDMMessage(
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

    return apiClient<DMMessage>(`/dms/${channelId}/messages`, {
      method: "POST",
      body: formData,
    });
  }

  return apiClient<DMMessage>(`/dms/${channelId}/messages`, {
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

/** Edits an E2EE DM message. */
export function editEncryptedDMMessage(
  messageId: string,
  ciphertext: string,
  senderDeviceId: string,
  metadata: string
) {
  return apiClient<DMMessage>(`/dms/messages/${messageId}`, {
    method: "PATCH",
    body: {
      encryption_version: 1,
      ciphertext,
      sender_device_id: senderDeviceId,
      e2ee_metadata: metadata,
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

/** Toggle emoji reaction on a DM message (adds if absent, removes if present). */
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

// ─── DM Settings ───

/** Pinned + muted DM IDs (initial load). */
export type DMSettingsResponse = {
  pinned_channel_ids: string[];
  muted_channel_ids: string[];
};

export function getDMSettings() {
  return apiClient<DMSettingsResponse>("/dms/settings");
}

export function hideDM(channelId: string) {
  return apiClient<void>(`/dms/channels/${channelId}/hide`, { method: "POST" });
}

export function unhideDM(channelId: string) {
  return apiClient<void>(`/dms/channels/${channelId}/hide`, { method: "DELETE" });
}

export function pinDMConversation(channelId: string) {
  return apiClient<void>(`/dms/channels/${channelId}/pin-conversation`, { method: "POST" });
}

export function unpinDMConversation(channelId: string) {
  return apiClient<void>(`/dms/channels/${channelId}/pin-conversation`, { method: "DELETE" });
}

export function muteDM(channelId: string, duration: string) {
  return apiClient<void>(`/dms/channels/${channelId}/mute`, {
    method: "POST",
    body: { duration },
  });
}

export function unmuteDM(channelId: string) {
  return apiClient<void>(`/dms/channels/${channelId}/mute`, { method: "DELETE" });
}

// ─── DM Requests ───

export function acceptDMRequest(channelId: string) {
  return apiClient<void>(`/dms/channels/${channelId}/accept`, { method: "POST" });
}

export function declineDMRequest(channelId: string) {
  return apiClient<void>(`/dms/channels/${channelId}/decline`, { method: "POST" });
}

// ─── E2EE Toggle ───

/** Toggle E2EE on a DM channel. Either participant can change it. */
export function toggleDME2EE(channelId: string, enabled: boolean) {
  return apiClient<{ id: string; e2ee_enabled: boolean }>(`/dms/channels/${channelId}/e2ee`, {
    method: "PATCH",
    body: { enabled },
  });
}

// ─── Search ───

export type DMSearchResult = {
  messages: DMMessage[];
  total_count: number;
};

/** FTS5 full-text search within a DM channel. Supports limit/offset pagination. */
export function searchDMMessages(channelId: string, query: string, limit = 25, offset = 0) {
  const params = new URLSearchParams({ q: query });
  if (limit !== 25) params.set("limit", String(limit));
  if (offset > 0) params.set("offset", String(offset));
  return apiClient<DMSearchResult>(`/dms/${channelId}/search?${params}`);
}
