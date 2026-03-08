/**
 * Pin API — server-scoped message pinning.
 *
 * Pin/unpin require ManageMessages permission.
 */

import { apiClient } from "./client";
import type { PinnedMessage } from "../types";

export async function getPins(serverId: string, channelId: string) {
  return apiClient<PinnedMessage[]>(`/servers/${serverId}/channels/${channelId}/pins`);
}

export async function pinMessage(serverId: string, channelId: string, messageId: string) {
  return apiClient<PinnedMessage>(
    `/servers/${serverId}/channels/${channelId}/messages/${messageId}/pin`,
    { method: "POST" }
  );
}

export async function unpinMessage(serverId: string, channelId: string, messageId: string) {
  return apiClient<{ message: string }>(
    `/servers/${serverId}/channels/${channelId}/messages/${messageId}/pin`,
    { method: "DELETE" }
  );
}
