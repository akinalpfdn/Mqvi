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

export async function joinServer(inviteCode: string) {
  return apiClient<Server>("/servers/join", {
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
    invite_required?: boolean;
    e2ee_enabled?: boolean;
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

/** Deletes the server (owner only). */
export async function deleteServer(serverId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}`, {
    method: "DELETE",
  });
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
