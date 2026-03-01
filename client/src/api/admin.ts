/**
 * Admin API — Platform admin LiveKit instance yönetimi.
 *
 * Bu endpoint'ler sadece is_platform_admin = true olan kullanıcılar tarafından
 * erişilebilir. Backend PlatformAdminMiddleware ile korunur.
 */

import { apiClient } from "./client";
import type {
  LiveKitInstanceAdmin,
  CreateLiveKitInstanceRequest,
  UpdateLiveKitInstanceRequest,
} from "../types";

/** Tüm platform-managed LiveKit instance'larını listeler. */
export async function listLiveKitInstances() {
  return apiClient<LiveKitInstanceAdmin[]>("/admin/livekit-instances");
}

/** Tek bir LiveKit instance'ı getirir. */
export async function getLiveKitInstance(id: string) {
  return apiClient<LiveKitInstanceAdmin>(`/admin/livekit-instances/${id}`);
}

/** Yeni bir platform-managed LiveKit instance oluşturur. */
export async function createLiveKitInstance(
  data: CreateLiveKitInstanceRequest
) {
  return apiClient<LiveKitInstanceAdmin>("/admin/livekit-instances", {
    method: "POST",
    body: data,
  });
}

/** Mevcut bir LiveKit instance'ı günceller. */
export async function updateLiveKitInstance(
  id: string,
  data: UpdateLiveKitInstanceRequest
) {
  return apiClient<LiveKitInstanceAdmin>(`/admin/livekit-instances/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/**
 * Bir LiveKit instance'ı siler.
 * Bağlı sunucular varsa migrateToId ile hedef instance belirtilmelidir.
 */
export async function deleteLiveKitInstance(
  id: string,
  migrateToId?: string
) {
  const url = migrateToId
    ? `/admin/livekit-instances/${id}?migrate_to=${migrateToId}`
    : `/admin/livekit-instances/${id}`;
  return apiClient<{ message: string }>(url, { method: "DELETE" });
}
