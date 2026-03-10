/**
 * Admin API — Platform admin LiveKit instance management.
 *
 * All endpoints require is_platform_admin = true.
 * Protected by PlatformAdminMiddleware on the backend.
 */

import { apiClient } from "./client";
import type {
  LiveKitInstanceAdmin,
  LiveKitInstanceMetrics,
  MetricsHistorySummary,
  MetricsTimeSeriesPoint,
  CreateLiveKitInstanceRequest,
  UpdateLiveKitInstanceRequest,
  AdminServerListItem,
  AdminUserListItem,
  AdminReportListItem,
  AppLog,
} from "../types";

export async function listLiveKitInstances() {
  return apiClient<LiveKitInstanceAdmin[]>("/admin/livekit-instances");
}

export async function getLiveKitInstance(id: string) {
  return apiClient<LiveKitInstanceAdmin>(`/admin/livekit-instances/${id}`);
}

export async function createLiveKitInstance(
  data: CreateLiveKitInstanceRequest
) {
  return apiClient<LiveKitInstanceAdmin>("/admin/livekit-instances", {
    method: "POST",
    body: data,
  });
}

export async function updateLiveKitInstance(
  id: string,
  data: UpdateLiveKitInstanceRequest
) {
  return apiClient<LiveKitInstanceAdmin>(`/admin/livekit-instances/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** If linked servers exist, migrateToId specifies the target instance. */
export async function deleteLiveKitInstance(
  id: string,
  migrateToId?: string
) {
  const url = migrateToId
    ? `/admin/livekit-instances/${id}?migrate_to=${migrateToId}`
    : `/admin/livekit-instances/${id}`;
  return apiClient<{ message: string }>(url, { method: "DELETE" });
}

export async function getLiveKitInstanceMetrics(id: string) {
  return apiClient<LiveKitInstanceMetrics>(
    `/admin/livekit-instances/${id}/metrics`
  );
}

export async function getLiveKitMetricsHistory(
  id: string,
  period: "24h" | "7d" | "30d" = "24h"
) {
  return apiClient<MetricsHistorySummary>(
    `/admin/livekit-instances/${id}/metrics/history?period=${period}`
  );
}

export async function getLiveKitMetricsTimeSeries(
  id: string,
  period: "24h" | "7d" | "30d" = "24h"
) {
  return apiClient<MetricsTimeSeriesPoint[]>(
    `/admin/livekit-instances/${id}/metrics/timeseries?period=${period}`
  );
}

export async function listAdminServers() {
  return apiClient<AdminServerListItem[]>("/admin/servers");
}

export async function listAdminUsers() {
  return apiClient<AdminUserListItem[]>("/admin/users");
}

export async function platformBanUser(
  userId: string,
  data: { reason: string; delete_messages: boolean }
) {
  return apiClient<{ message: string }>(`/admin/users/${userId}/ban`, {
    method: "POST",
    body: data,
  });
}

export async function platformUnbanUser(userId: string) {
  return apiClient<{ message: string }>(`/admin/users/${userId}/ban`, {
    method: "DELETE",
  });
}

/** Permanently deletes user and all their data. Optional reason triggers email notification. */
export async function hardDeleteUser(
  userId: string,
  data?: { reason: string }
) {
  return apiClient<{ message: string }>(`/admin/users/${userId}`, {
    method: "DELETE",
    body: data,
  });
}

/** Permanently deletes server with platform admin authority. Optional reason triggers owner notification. */
export async function adminDeleteServer(
  serverId: string,
  data?: { reason: string }
) {
  return apiClient<{ message: string }>(`/admin/servers/${serverId}`, {
    method: "DELETE",
    body: data,
  });
}

export async function setUserPlatformAdmin(
  userId: string,
  data: { is_admin: boolean }
) {
  return apiClient<{ message: string }>(`/admin/users/${userId}/platform-admin`, {
    method: "PATCH",
    body: data,
  });
}

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

export async function listAdminReports(status?: string) {
  const query = status ? `?status=${status}&limit=100` : "?limit=100";
  return apiClient<{ reports: AdminReportListItem[]; total: number }>(
    `/admin/reports${query}`
  );
}

export async function updateReportStatus(reportId: string, status: string) {
  return apiClient<{ message: string }>(`/admin/reports/${reportId}/status`, {
    method: "PATCH",
    body: { status },
  });
}

// ── App Logs ──

export async function listAppLogs(params?: {
  level?: string;
  category?: string;
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const query = new URLSearchParams();
  if (params?.level) query.set("level", params.level);
  if (params?.category) query.set("category", params.category);
  if (params?.search) query.set("search", params.search);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.offset) query.set("offset", String(params.offset));

  const qs = query.toString();
  return apiClient<{ logs: AppLog[]; total: number }>(
    `/admin/logs${qs ? `?${qs}` : ""}`
  );
}

export async function clearAppLogs() {
  return apiClient<{ status: string }>("/admin/logs", { method: "DELETE" });
}
