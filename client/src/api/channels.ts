/**
 * Channel & Category API — server-scoped CRUD.
 *
 * - GET    /api/servers/{serverId}/channels         — channels grouped by category
 * - POST   /api/servers/{serverId}/channels         — create channel [MANAGE_CHANNELS]
 * - PATCH  /api/servers/{serverId}/channels/{id}    — update channel [MANAGE_CHANNELS]
 * - DELETE /api/servers/{serverId}/channels/{id}    — delete channel [MANAGE_CHANNELS]
 * - PATCH  /api/servers/{serverId}/channels/reorder — reorder channels [MANAGE_CHANNELS]
 * - GET    /api/servers/{serverId}/categories       — list categories
 * - POST   /api/servers/{serverId}/categories       — create category [MANAGE_CHANNELS]
 * - PATCH  /api/servers/{serverId}/categories/{id}  — update category [MANAGE_CHANNELS]
 * - DELETE /api/servers/{serverId}/categories/{id}  — delete category [MANAGE_CHANNELS]
 * - PATCH  /api/servers/{serverId}/categories/reorder — reorder categories [MANAGE_CHANNELS]
 */

import { apiClient } from "./client";
import type {
  CategoryWithChannels,
  Channel,
  Category,
} from "../types";

// ─── Channel API ───

export async function getChannels(serverId: string) {
  return apiClient<CategoryWithChannels[]>(`/servers/${serverId}/channels`);
}

export async function createChannel(serverId: string, data: {
  name: string;
  type: string;
  category_id?: string;
  topic?: string;
}) {
  return apiClient<Channel>(`/servers/${serverId}/channels`, {
    method: "POST",
    body: data,
  });
}

export async function updateChannel(
  serverId: string,
  id: string,
  data: { name?: string; topic?: string; category_id?: string }
) {
  return apiClient<Channel>(`/servers/${serverId}/channels/${id}`, {
    method: "PATCH",
    body: data,
  });
}

export async function deleteChannel(serverId: string, id: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/channels/${id}`, {
    method: "DELETE",
  });
}

/**
 * Batch reorder channels. category_id is optional — when set, moves the channel
 * to a different category (cross-category drag-and-drop).
 */
export async function reorderChannels(serverId: string, items: { id: string; position: number; category_id?: string }[]) {
  return apiClient<CategoryWithChannels[]>(`/servers/${serverId}/channels/reorder`, {
    method: "PATCH",
    body: { items },
  });
}

// ─── Category API ───

export async function getCategories(serverId: string) {
  return apiClient<Category[]>(`/servers/${serverId}/categories`);
}

export async function createCategory(serverId: string, data: { name: string }) {
  return apiClient<Category>(`/servers/${serverId}/categories`, {
    method: "POST",
    body: data,
  });
}

export async function updateCategory(serverId: string, id: string, data: { name?: string }) {
  return apiClient<Category>(`/servers/${serverId}/categories/${id}`, {
    method: "PATCH",
    body: data,
  });
}

export async function reorderCategories(serverId: string, items: { id: string; position: number }[]) {
  return apiClient<Category[]>(`/servers/${serverId}/categories/reorder`, {
    method: "PATCH",
    body: { items },
  });
}

export async function deleteCategory(serverId: string, id: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/categories/${id}`, {
    method: "DELETE",
  });
}

// ─── Channel Mute API ───

export async function muteChannel(serverId: string, channelId: string, duration: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/channels/${channelId}/mute`, {
    method: "POST",
    body: { duration },
  });
}

export async function unmuteChannel(serverId: string, channelId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/channels/${channelId}/mute`, {
    method: "DELETE",
  });
}

export async function getMutedChannels() {
  return apiClient<string[]>("/channels/mutes");
}
