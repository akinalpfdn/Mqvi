/**
 * Channel Permission Override API fonksiyonları.
 *
 * Multi-server: Tüm endpoint'ler server-scoped.
 * Backend endpoint'leri:
 * - GET    /api/servers/{serverId}/channels/{id}/permissions               → Override'ları listele
 * - PUT    /api/servers/{serverId}/channels/{channelId}/permissions/{roleId} → Override oluştur/güncelle
 * - DELETE /api/servers/{serverId}/channels/{channelId}/permissions/{roleId} → Override sil
 *
 * Tüm CUD endpoint'leri ManageChannels yetkisi gerektirir.
 */

import { apiClient } from "./client";
import type { ChannelPermissionOverride } from "../types";

/** Bir kanaldaki tüm permission override'ları getirir */
export async function getOverrides(serverId: string, channelID: string) {
  return apiClient<ChannelPermissionOverride[]>(
    `/servers/${serverId}/channels/${channelID}/permissions`
  );
}

/** Bir kanal-rol çifti için override oluşturur veya günceller (UPSERT) */
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

/** Bir kanal-rol çifti için override'ı siler (inherit'e döner) */
export async function deleteOverride(serverId: string, channelID: string, roleID: string) {
  return apiClient<{ message: string }>(
    `/servers/${serverId}/channels/${channelID}/permissions/${roleID}`,
    {
      method: "DELETE",
    }
  );
}
