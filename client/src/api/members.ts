/**
 * Member API fonksiyonları.
 *
 * Multi-server: Tüm endpoint'ler server-scoped.
 * Backend endpoint'leri:
 * - GET    /api/servers/{serverId}/members            → Tüm üyeleri rolleriyle döner
 * - GET    /api/servers/{serverId}/members/{id}       → Belirli üye
 * - PATCH  /api/servers/{serverId}/members/{id}/roles → Üye rollerini değiştir [MANAGE_ROLES]
 * - DELETE /api/servers/{serverId}/members/{id}       → Üye kick [KICK_MEMBERS]
 * - POST   /api/servers/{serverId}/members/{id}/ban   → Üye ban [BAN_MEMBERS]
 * - GET    /api/servers/{serverId}/bans               → Banlı üye listesi [BAN_MEMBERS]
 * - DELETE /api/servers/{serverId}/bans/{id}          → Unban [BAN_MEMBERS]
 * - PATCH  /api/users/me/profile                      → Profil güncelleme (global)
 */

import { apiClient } from "./client";
import type { MemberWithRoles, Ban } from "../types";

/** Tüm üyeleri rolleriyle getirir */
export async function getMembers(serverId: string) {
  return apiClient<MemberWithRoles[]>(`/servers/${serverId}/members`);
}

/** Belirli bir üyeyi getirir */
export async function getMember(serverId: string, id: string) {
  return apiClient<MemberWithRoles>(`/servers/${serverId}/members/${id}`);
}

/** Üyenin rollerini değiştirir */
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

/** Üyeyi sunucudan çıkarır (kick) */
export async function kickMember(serverId: string, targetId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/members/${targetId}`, {
    method: "DELETE",
  });
}

/** Üyeyi yasaklar (ban) */
export async function banMember(serverId: string, targetId: string, reason: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/members/${targetId}/ban`, {
    method: "POST",
    body: { reason },
  });
}

/** Tüm banlı üyeleri listeler */
export async function getBans(serverId: string) {
  return apiClient<Ban[]>(`/servers/${serverId}/bans`);
}

/** Üyenin yasağını kaldırır */
export async function unbanMember(serverId: string, userId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/bans/${userId}`, {
    method: "DELETE",
  });
}

/** Kendi profilini günceller (global — sunucu bağımsız) */
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
