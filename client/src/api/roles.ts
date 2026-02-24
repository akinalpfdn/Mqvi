/**
 * Role API fonksiyonları.
 *
 * Backend endpoint'leri:
 * - GET    /api/roles       → Tüm rolleri döner
 * - POST   /api/roles       → Yeni rol oluştur [MANAGE_ROLES]
 * - PATCH  /api/roles/{id}  → Rol güncelle [MANAGE_ROLES]
 * - DELETE /api/roles/{id}       → Rol sil [MANAGE_ROLES]
 * - PATCH  /api/roles/reorder   → Rol sıralamasını güncelle [MANAGE_ROLES]
 */

import { apiClient } from "./client";
import type { Role } from "../types";

/** Tüm rolleri getirir (position DESC sıralı) */
export async function getRoles() {
  return apiClient<Role[]>("/roles");
}

/** Yeni rol oluşturur */
export async function createRole(data: {
  name: string;
  color: string;
  permissions: number;
}) {
  return apiClient<Role>("/roles", {
    method: "POST",
    body: data,
  });
}

/** Rolü günceller (partial update) */
export async function updateRole(
  id: string,
  data: { name?: string; color?: string; permissions?: number }
) {
  return apiClient<Role>(`/roles/${id}`, {
    method: "PATCH",
    body: data,
  });
}

/** Rolü siler */
export async function deleteRole(id: string) {
  return apiClient<{ message: string }>(`/roles/${id}`, {
    method: "DELETE",
  });
}

/** Rol sıralamasını toplu günceller */
export async function reorderRoles(items: { id: string; position: number }[]) {
  return apiClient<Role[]>("/roles/reorder", {
    method: "PATCH",
    body: { items },
  });
}
