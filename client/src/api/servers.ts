/**
 * Servers API — multi-server CRUD + membership endpoints.
 *
 * - GET    /api/servers                     — user's server list
 * - POST   /api/servers                     — create server
 * - POST   /api/servers/join                — join via invite code
 * - GET    /api/servers/{serverId}          — server details
 * - PATCH  /api/servers/{serverId}          — update server [Admin]
 * - DELETE /api/servers/{serverId}          — delete server [Owner]
 * - POST   /api/servers/{serverId}/leave    — leave server
 * - POST   /api/servers/{serverId}/icon     — upload server icon [Admin]
 * - GET    /api/servers/{serverId}/livekit  — LiveKit settings [Admin]
 */

import { apiClient } from "./client";
import type {
  Server,
  ServerListItem,
  CreateServerRequest,
} from "../types";

export async function getMyServers() {
  return apiClient<ServerListItem[]>("/servers");
}

export async function createServer(data: CreateServerRequest) {
  return apiClient<Server>("/servers", {
    method: "POST",
    body: data,
  });
}

/** POST /servers/join response — pending=true means an approval request was created (no membership yet). */
export type JoinServerResponse = { pending: boolean; server?: Server };

export async function joinServer(inviteCode: string) {
  return apiClient<JoinServerResponse>("/servers/join", {
    method: "POST",
    body: { invite_code: inviteCode },
  });
}

export async function getServer(serverId: string) {
  return apiClient<Server>(`/servers/${serverId}`);
}

export async function updateServer(
  serverId: string,
  data: {
    name?: string;
    is_public?: boolean;
    e2ee_enabled?: boolean;
    approval_required?: boolean;
    afk_timeout_minutes?: number;
    livekit_url?: string;
    livekit_key?: string;
    livekit_secret?: string;
  }
) {
  return apiClient<Server>(`/servers/${serverId}`, {
    method: "PATCH",
    body: data,
  });
}

/** Soft-deletes the server (owner only). Recoverable for 30 days. */
export async function deleteServer(serverId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}`, {
    method: "DELETE",
  });
}

/** Restores a soft-deleted server (owner only). */
export async function restoreServer(serverId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/restore`, {
    method: "POST",
  });
}

/** Permanently deletes a soft-deleted server (skip 30-day TTL, owner only). */
export async function hardDeleteServer(serverId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/permanent`, {
    method: "DELETE",
  });
}

export interface DeletedServerInfo {
  id: string;
  name: string;
  icon_url: string | null;
  deleted_at: string;
  deleted_by_admin: boolean;
  permanent_delete_at: string;
}

/** Lists soft-deleted servers owned by the current user. */
export async function getDeletedServers() {
  return apiClient<DeletedServerInfo[]>("/users/me/deleted-servers");
}

/** Leaves the server (owner cannot leave). */
export async function leaveServer(serverId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/leave`, {
    method: "POST",
  });
}

/** Returns LiveKit settings (URL + type info, no secret). */
export async function getLiveKitSettings(serverId: string) {
  return apiClient<{ url: string; is_platform_managed: boolean }>(
    `/servers/${serverId}/livekit`
  );
}

/** Reorders user's server list (per-user). */
export async function reorderServers(items: { id: string; position: number }[]) {
  return apiClient<ServerListItem[]>("/servers/reorder", {
    method: "PATCH",
    body: { items },
  });
}

// ─── Server Mute ───

export async function muteServer(serverId: string, duration: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/mute`, {
    method: "POST",
    body: { duration },
  });
}

export async function unmuteServer(serverId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/mute`, {
    method: "DELETE",
  });
}

export async function getMutedServers() {
  return apiClient<string[]>("/servers/mutes");
}

/** Uploads server icon — multipart/form-data. */
export async function uploadServerIcon(serverId: string, file: File) {
  const formData = new FormData();
  formData.append("file", file);

  return apiClient<Server>(`/servers/${serverId}/icon`, {
    method: "POST",
    body: formData,
  });
}
