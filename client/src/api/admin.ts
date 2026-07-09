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

export type AdminListParams = {
  limit: number;
  offset: number;
  search?: string;
  statuses?: string[]; // deletion/account state; empty = all
  presences?: string[]; // users only: presence
  admin?: string[]; // users only: "admin"/"non_admin"
  types?: string[]; // servers only: "managed"/"self"
  sort?: string;
  dir?: "asc" | "desc";
};

export type AdminListPage<T> = {
  items: T[];
  total: number;
};

function buildAdminListQuery(params: AdminListParams): string {
  const sp = new URLSearchParams();
  sp.set("limit", String(params.limit));
  sp.set("offset", String(params.offset));
  if (params.search) sp.set("search", params.search);
  for (const s of params.statuses ?? []) sp.append("status", s);
  for (const p of params.presences ?? []) sp.append("presence", p);
  for (const a of params.admin ?? []) sp.append("admin", a);
  for (const ty of params.types ?? []) sp.append("type", ty);
  if (params.sort) sp.set("sort", params.sort);
  if (params.dir) sp.set("dir", params.dir);
  return sp.toString();
}

export async function listAdminServers(params: AdminListParams) {
  return apiClient<AdminListPage<AdminServerListItem>>(`/admin/servers?${buildAdminListQuery(params)}`);
}

export async function listAdminUsers(params: AdminListParams) {
  return apiClient<AdminListPage<AdminUserListItem>>(`/admin/users?${buildAdminListQuery(params)}`);
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

/**
 * Deletes a user.
 * - hardDelete=false (default): soft-delete (recoverable, 30-day TTL).
 * - hardDelete=true: tombstone (anonymize, irreversible).
 * Optional reason triggers email notification.
 */
export async function hardDeleteUser(
  userId: string,
  data?: { reason?: string; hard_delete?: boolean }
) {
  return apiClient<{ message: string }>(`/admin/users/${userId}`, {
    method: "DELETE",
    body: data,
  });
}

/** Restores a soft-deleted user (admin override). Tombstones not restorable. */
export async function adminRestoreUser(userId: string) {
  return apiClient<{ message: string }>(`/admin/users/${userId}/restore`, {
    method: "POST",
  });
}

/**
 * Deletes a server with platform admin authority.
 * - hard_delete=false (default): soft-delete with deleted_by_admin=1 (owner cannot restore).
 * - hard_delete=true: permanent delete (skip TTL).
 * Optional reason triggers owner email notification.
 */
export async function adminDeleteServer(
  serverId: string,
  data?: { reason?: string; hard_delete?: boolean }
) {
  return apiClient<{ message: string }>(`/admin/servers/${serverId}`, {
    method: "DELETE",
    body: data,
  });
}

/** Restores a soft-deleted server (admin override, works regardless of who soft-deleted). */
export async function adminRestoreServer(serverId: string) {
  return apiClient<{ message: string }>(`/admin/servers/${serverId}/restore`, {
    method: "POST",
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

export async function setUserQuota(userId: string, quotaBytes: number) {
  return apiClient<{ message: string }>(`/admin/users/${userId}/quota`, {
    method: "PATCH",
    body: { quota_bytes: quotaBytes },
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

export type AdminBadgesResponse = {
  has_new_feedback: boolean;
  has_new_reports: boolean;
};

export async function getAdminBadges() {
  return apiClient<AdminBadgesResponse>("/admin/badges");
}

export async function markFeedbackSeen() {
  return apiClient<void>("/admin/feedback/mark-seen", { method: "POST" });
}

export async function markReportsSeen() {
  return apiClient<void>("/admin/reports/mark-seen", { method: "POST" });
}
