/**
 * Channel & Category API fonksiyonları.
 *
 * Multi-server: Tüm list/create endpoint'leri server-scoped.
 * Backend endpoint'leri:
 * - GET    /api/servers/{serverId}/channels         → Kanalları kategorilere göre gruplu döner
 * - POST   /api/servers/{serverId}/channels         → Yeni kanal oluştur [MANAGE_CHANNELS]
 * - PATCH  /api/servers/{serverId}/channels/{id}    → Kanal güncelle [MANAGE_CHANNELS]
 * - DELETE /api/servers/{serverId}/channels/{id}    → Kanal sil [MANAGE_CHANNELS]
 * - PATCH  /api/servers/{serverId}/channels/reorder → Kanal sıralamasını güncelle [MANAGE_CHANNELS]
 * - GET    /api/servers/{serverId}/categories       → Tüm kategorileri döner
 * - POST   /api/servers/{serverId}/categories       → Yeni kategori oluştur [MANAGE_CHANNELS]
 * - PATCH  /api/servers/{serverId}/categories/{id}  → Kategori güncelle [MANAGE_CHANNELS]
 * - DELETE /api/servers/{serverId}/categories/{id}  → Kategori sil [MANAGE_CHANNELS]
 */

import { apiClient } from "./client";
import type {
  CategoryWithChannels,
  Channel,
  Category,
} from "../types";

// ─── Channel API ───

/** Tüm kanalları kategorilere göre gruplu getirir */
export async function getChannels(serverId: string) {
  return apiClient<CategoryWithChannels[]>(`/servers/${serverId}/channels`);
}

/** Yeni kanal oluşturur */
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

/** Kanalı günceller */
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

/** Kanalı siler */
export async function deleteChannel(serverId: string, id: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/channels/${id}`, {
    method: "DELETE",
  });
}

/** Kanal sıralamasını toplu günceller */
export async function reorderChannels(serverId: string, items: { id: string; position: number }[]) {
  return apiClient<CategoryWithChannels[]>(`/servers/${serverId}/channels/reorder`, {
    method: "PATCH",
    body: { items },
  });
}

// ─── Category API ───

/** Tüm kategorileri getirir */
export async function getCategories(serverId: string) {
  return apiClient<Category[]>(`/servers/${serverId}/categories`);
}

/** Yeni kategori oluşturur */
export async function createCategory(serverId: string, data: { name: string }) {
  return apiClient<Category>(`/servers/${serverId}/categories`, {
    method: "POST",
    body: data,
  });
}

/** Kategoriyi günceller */
export async function updateCategory(serverId: string, id: string, data: { name?: string }) {
  return apiClient<Category>(`/servers/${serverId}/categories/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** Kategoriyi siler */
export async function deleteCategory(serverId: string, id: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/categories/${id}`, {
    method: "DELETE",
  });
}
