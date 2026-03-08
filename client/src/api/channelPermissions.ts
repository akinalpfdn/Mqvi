/**
 * Channel Permission Override API — server-scoped per-channel role overrides.
 *
 * All CUD endpoints require ManageChannels permission.
 */

import { apiClient } from "./client";
import type { ChannelPermissionOverride } from "../types";

export async function getOverrides(serverId: string, channelID: string) {
  return apiClient<ChannelPermissionOverride[]>(
    `/servers/${serverId}/channels/${channelID}/permissions`
  );
}

/** Creates or updates (UPSERT) a permission override for a channel-role pair. */
export async function setOverride(
  serverId: string,
  channelID: string,
  roleID: string,
  allow: number,
  deny: number
) {
  return apiClient<{ message: string }>(
    `/servers/${serverId}/channels/${channelID}/permissions/${roleID}`,
    {
      method: "PUT",
      body: { allow, deny },
    }
  );
}

/** Deletes a permission override (reverts to inherited). */
export async function deleteOverride(serverId: string, channelID: string, roleID: string) {
  return apiClient<{ message: string }>(
    `/servers/${serverId}/channels/${channelID}/permissions/${roleID}`,
    {
      method: "DELETE",
    }
  );
}
