/**
 * Role API fonksiyonları.
 *
 * Multi-server: Tüm endpoint'ler server-scoped.
 * Backend endpoint'leri:
 * - GET    /api/servers/{serverId}/roles          → Tüm rolleri döner
 * - POST   /api/servers/{serverId}/roles          → Yeni rol oluştur [MANAGE_ROLES]
 * - PATCH  /api/servers/{serverId}/roles/{id}     → Rol güncelle [MANAGE_ROLES]
 * - DELETE /api/servers/{serverId}/roles/{id}     → Rol sil [MANAGE_ROLES]
 * - PATCH  /api/servers/{serverId}/roles/reorder  → Rol sıralamasını güncelle [MANAGE_ROLES]
 */

import { apiClient } from "./client";
import type { Role } from "../types";

/** Tüm rolleri getirir (position DESC sıralı) */
export async function getRoles(serverId: string) {
  return apiClient<Role[]>(`/servers/${serverId}/roles`);
}

/** Yeni rol oluşturur */
export async function createRole(serverId: string, data: {
  name: string;
  color: string;
  permissions: number;
}) {
  return apiClient<Role>(`/servers/${serverId}/roles`, {
    method: "POST",
    body: data,
  });
}

/** Rolü günceller (partial update) */
export async function updateRole(
  serverId: string,
  id: string,
  data: { name?: string; color?: string; permissions?: number }
) {
  return apiClient<Role>(`/servers/${serverId}/roles/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** Rolü siler */
export async function deleteRole(serverId: string, id: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/roles/${id}`, {
    method: "DELETE",
  });
}

/** Rol sıralamasını toplu günceller */
export async function reorderRoles(serverId: string, items: { id: string; position: number }[]) {
  return apiClient<Role[]>(`/servers/${serverId}/roles/reorder`, {
    method: "PATCH",
    body: { items },
  });
}
