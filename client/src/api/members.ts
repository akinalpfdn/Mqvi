/**
 * Member API fonksiyonları.
 *
 * Backend endpoint'leri:
 * - GET    /api/members            → Tüm üyeleri rolleriyle döner
 * - GET    /api/members/{id}       → Belirli üye
 * - PATCH  /api/members/{id}/roles → Üye rollerini değiştir [MANAGE_ROLES]
 * - DELETE /api/members/{id}       → Üye kick [KICK_MEMBERS]
 * - POST   /api/members/{id}/ban   → Üye ban [BAN_MEMBERS]
 * - GET    /api/bans               → Banlı üye listesi [BAN_MEMBERS]
 * - DELETE /api/bans/{id}          → Unban [BAN_MEMBERS]
 * - PATCH  /api/users/me/profile   → Profil güncelleme
 */

import { apiClient } from "./client";
import type { MemberWithRoles, Ban } from "../types";

/** Tüm üyeleri rolleriyle getirir */
export async function getMembers() {
  return apiClient<MemberWithRoles[]>("/members");
}

/** Belirli bir üyeyi getirir */
export async function getMember(id: string) {
  return apiClient<MemberWithRoles>(`/members/${id}`);
}

/** Üyenin rollerini değiştirir */
export async function modifyMemberRoles(
  targetId: string,
  roleIds: string[]
) {
  return apiClient<MemberWithRoles>(`/members/${targetId}/roles`, {
    method: "PATCH",
    body: { role_ids: roleIds },
  });
}

/** Üyeyi sunucudan çıkarır (kick) */
export async function kickMember(targetId: string) {
  return apiClient<{ message: string }>(`/members/${targetId}`, {
    method: "DELETE",
  });
}

/** Üyeyi yasaklar (ban) */
export async function banMember(targetId: string, reason: string) {
  return apiClient<{ message: string }>(`/members/${targetId}/ban`, {
    method: "POST",
    body: { reason },
  });
}

/** Tüm banlı üyeleri listeler */
export async function getBans() {
  return apiClient<Ban[]>("/bans");
}

/** Üyenin yasağını kaldırır */
export async function unbanMember(userId: string) {
  return apiClient<{ message: string }>(`/bans/${userId}`, {
    method: "DELETE",
  });
}

/** Kendi profilini günceller */
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
