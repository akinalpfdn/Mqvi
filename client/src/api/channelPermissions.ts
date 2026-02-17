/**
 * Channel Permission Override API fonksiyonları.
 *
 * Backend endpoint'leri:
 * - GET    /api/channels/{id}/permissions               → Override'ları listele
 * - PUT    /api/channels/{channelId}/permissions/{roleId} → Override oluştur/güncelle
 * - DELETE /api/channels/{channelId}/permissions/{roleId} → Override sil
 *
 * Tüm CUD endpoint'leri ManageChannels yetkisi gerektirir.
 */

import { apiClient } from "./client";
import type { ChannelPermissionOverride } from "../types";

/** Bir kanaldaki tüm permission override'ları getirir */
export async function getOverrides(channelID: string) {
  return apiClient<ChannelPermissionOverride[]>(
    `/channels/${channelID}/permissions`
  );
}

/** Bir kanal-rol çifti için override oluşturur veya günceller (UPSERT) */
export async function setOverride(
  channelID: string,
  roleID: string,
  allow: number,
  deny: number
) {
  return apiClient<{ message: string }>(
    `/channels/${channelID}/permissions/${roleID}`,
    {
      method: "PUT",
      body: { allow, deny },
    }
  );
}

/** Bir kanal-rol çifti için override'ı siler (inherit'e döner) */
export async function deleteOverride(channelID: string, roleID: string) {
  return apiClient<{ message: string }>(
    `/channels/${channelID}/permissions/${roleID}`,
    {
      method: "DELETE",
    }
  );
}
