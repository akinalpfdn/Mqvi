/**
 * Role API — server-scoped role CRUD + reordering.
 *
 * All mutating endpoints require MANAGE_ROLES permission.
 */

import { apiClient } from "./client";
import type { Role } from "../types";

/** Returns all roles sorted by position DESC. */
export async function getRoles(serverId: string) {
  return apiClient<Role[]>(`/servers/${serverId}/roles`);
}

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

export async function deleteRole(serverId: string, id: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/roles/${id}`, {
    method: "DELETE",
  });
}

export async function reorderRoles(serverId: string, items: { id: string; position: number }[]) {
  return apiClient<Role[]>(`/servers/${serverId}/roles/reorder`, {
    method: "PATCH",
    body: { items },
  });
}
