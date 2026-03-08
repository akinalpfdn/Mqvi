/**
 * Invites API — server-scoped invite code CRUD.
 *
 * All endpoints require ManageInvites permission.
 */

import { apiClient } from "./client";
import type { Invite } from "../types";

export async function getInvites(serverId: string) {
  return apiClient<Invite[]>(`/servers/${serverId}/invites`);
}

export async function createInvite(serverId: string, data: {
  max_uses: number;
  expires_in: number;
}) {
  return apiClient<Invite>(`/servers/${serverId}/invites`, {
    method: "POST",
    body: data,
  });
}

export async function deleteInvite(serverId: string, code: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/invites/${code}`, {
    method: "DELETE",
  });
}

/** Invite code preview — server name, icon, member count (no auth required). */
export type InvitePreview = {
  server_name: string;
  server_icon_url: string | null;
  member_count: number;
};

export async function getInvitePreview(code: string) {
  return apiClient<InvitePreview>(`/invites/${code}/preview`);
}
