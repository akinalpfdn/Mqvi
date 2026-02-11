/**
 * Channel & Category API fonksiyonları.
 *
 * Backend endpoint'leri:
 * - GET    /api/channels         → Tüm kanalları kategorilere göre gruplu döner
 * - POST   /api/channels         → Yeni kanal oluştur [MANAGE_CHANNELS]
 * - PATCH  /api/channels/{id}    → Kanal güncelle [MANAGE_CHANNELS]
 * - DELETE /api/channels/{id}    → Kanal sil [MANAGE_CHANNELS]
 * - GET    /api/categories       → Tüm kategorileri döner
 * - POST   /api/categories       → Yeni kategori oluştur [MANAGE_CHANNELS]
 * - PATCH  /api/categories/{id}  → Kategori güncelle [MANAGE_CHANNELS]
 * - DELETE /api/categories/{id}  → Kategori sil [MANAGE_CHANNELS]
 */

import { apiClient } from "./client";
import type {
  CategoryWithChannels,
  Channel,
  Category,
} from "../types";

// ─── Channel API ───

/** Tüm kanalları kategorilere göre gruplu getirir */
export async function getChannels() {
  return apiClient<CategoryWithChannels[]>("/channels");
}

/** Yeni kanal oluşturur */
export async function createChannel(data: {
  name: string;
  type: string;
  category_id?: string;
  topic?: string;
}) {
  return apiClient<Channel>("/channels", {
    method: "POST",
    body: data,
  });
}

/** Kanalı günceller */
export async function updateChannel(
  id: string,
  data: { name?: string; topic?: string; category_id?: string }
) {
  return apiClient<Channel>(`/channels/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** Kanalı siler */
export async function deleteChannel(id: string) {
  return apiClient<{ message: string }>(`/channels/${id}`, {
    method: "DELETE",
  });
}

// ─── Category API ───

/** Tüm kategorileri getirir */
export async function getCategories() {
  return apiClient<Category[]>("/categories");
}

/** Yeni kategori oluşturur */
export async function createCategory(data: { name: string }) {
  return apiClient<Category>("/categories", {
    method: "POST",
    body: data,
  });
}

/** Kategoriyi günceller */
export async function updateCategory(id: string, data: { name?: string }) {
  return apiClient<Category>(`/categories/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** Kategoriyi siler */
export async function deleteCategory(id: string) {
  return apiClient<{ message: string }>(`/categories/${id}`, {
    method: "DELETE",
  });
}
