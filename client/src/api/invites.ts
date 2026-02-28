/**
 * Invites API fonksiyonları — davet kodu CRUD endpoint'leri.
 *
 * Multi-server: Tüm endpoint'ler server-scoped.
 * - GET    /api/servers/{serverId}/invites        → davet listesi
 * - POST   /api/servers/{serverId}/invites        → yeni davet oluştur
 * - DELETE /api/servers/{serverId}/invites/{code}  → davet sil
 *
 * Tüm endpoint'ler ManageInvites yetkisi gerektirir.
 */

import { apiClient } from "./client";
import type { Invite } from "../types";

/** Tüm davet kodlarını listele */
export async function getInvites(serverId: string) {
  return apiClient<Invite[]>(`/servers/${serverId}/invites`);
}

/** Yeni davet kodu oluştur */
export async function createInvite(serverId: string, data: {
  max_uses: number;
  expires_in: number;
}) {
  return apiClient<Invite>(`/servers/${serverId}/invites`, {
    method: "POST",
    body: data,
  });
}

/** Davet kodunu sil */
export async function deleteInvite(serverId: string, code: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/invites/${code}`, {
    method: "DELETE",
  });
}
