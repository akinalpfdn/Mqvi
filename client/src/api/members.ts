/**
 * Member API — server-scoped member management.
 *
 * Includes role assignment, kick, ban/unban, and profile update.
 */

import { apiClient } from "./client";
import type { MemberWithRoles, Ban } from "../types";

export async function getMembers(serverId: string) {
  return apiClient<MemberWithRoles[]>(`/servers/${serverId}/members`);
}

export async function getMember(serverId: string, id: string) {
  return apiClient<MemberWithRoles>(`/servers/${serverId}/members/${id}`);
}

export async function modifyMemberRoles(
  serverId: string,
  targetId: string,
  roleIds: string[]
) {
  return apiClient<MemberWithRoles>(`/servers/${serverId}/members/${targetId}/roles`, {
    method: "PATCH",
    body: { role_ids: roleIds },
  });
}

export async function kickMember(serverId: string, targetId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/members/${targetId}`, {
    method: "DELETE",
  });
}

export async function banMember(serverId: string, targetId: string, reason: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/members/${targetId}/ban`, {
    method: "POST",
    body: { reason },
  });
}

export async function getBans(serverId: string) {
  return apiClient<Ban[]>(`/servers/${serverId}/bans`);
}

export async function unbanMember(serverId: string, userId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/bans/${userId}`, {
    method: "DELETE",
  });
}

/** Updates own profile (global, not server-scoped). */
export async function updateProfile(data: {
  display_name?: string;
  avatar_url?: string;
  custom_status?: string;
}) {
  return apiClient<MemberWithRoles>("/users/me/profile", {
    method: "PATCH",
    body: data,
  });
}
