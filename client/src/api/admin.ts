/**
 * Admin API — Platform admin LiveKit instance yönetimi.
 *
 * Bu endpoint'ler sadece is_platform_admin = true olan kullanıcılar tarafından
 * erişilebilir. Backend PlatformAdminMiddleware ile korunur.
 */

import { apiClient } from "./client";
import type {
  LiveKitInstanceAdmin,
  LiveKitInstanceMetrics,
  MetricsHistorySummary,
  CreateLiveKitInstanceRequest,
  UpdateLiveKitInstanceRequest,
  AdminServerListItem,
  AdminUserListItem,
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

/** Bir LiveKit instance'ın anlık Prometheus metriklerini çeker. */
export async function getLiveKitInstanceMetrics(id: string) {
  return apiClient<LiveKitInstanceMetrics>(
    `/admin/livekit-instances/${id}/metrics`
  );
}

/** Bir LiveKit instance'ın tarihsel metrik özetini getirir (admin). */
export async function getLiveKitMetricsHistory(
  id: string,
  period: "24h" | "7d" | "30d" = "24h"
) {
  return apiClient<MetricsHistorySummary>(
    `/admin/livekit-instances/${id}/metrics/history?period=${period}`
  );
}

/** Platformdaki tüm sunucuları istatistikleriyle listeler (admin). */
export async function listAdminServers() {
  return apiClient<AdminServerListItem[]>("/admin/servers");
}

/** Platformdaki tüm kullanıcıları istatistikleriyle listeler (admin). */
export async function listAdminUsers() {
  return apiClient<AdminUserListItem[]>("/admin/users");
}

/** Tek bir sunucunun LiveKit instance'ını değiştirir (admin). */
export async function migrateServerInstance(
  serverId: string,
  livekitInstanceId: string
) {
  return apiClient<{ message: string }>(
    `/admin/servers/${serverId}/instance`,
    {
      method: "PATCH",
      body: { livekit_instance_id: livekitInstanceId },
    }
  );
}
