/**
 * Servers API — Multi-server CRUD + üyelik endpoint'leri.
 *
 * Backend endpoint'leri:
 * - GET    /api/servers                     → Kullanıcının sunucu listesi
 * - POST   /api/servers                     → Yeni sunucu oluştur
 * - POST   /api/servers/join                → Davet koduyla katıl
 * - GET    /api/servers/{serverId}          → Sunucu detayı
 * - PATCH  /api/servers/{serverId}          → Sunucu güncelle [Admin]
 * - DELETE /api/servers/{serverId}          → Sunucu sil [Owner]
 * - POST   /api/servers/{serverId}/leave    → Sunucudan ayrıl
 * - POST   /api/servers/{serverId}/icon     → Sunucu ikonu yükle [Admin]
 * - GET    /api/servers/{serverId}/livekit  → LiveKit ayarları [Admin]
 */

import { apiClient } from "./client";
import type {
  Server,
  ServerListItem,
  CreateServerRequest,
} from "../types";

/** Kullanıcının üye olduğu sunucuları listeler */
export async function getMyServers() {
  return apiClient<ServerListItem[]>("/servers");
}

/** Yeni sunucu oluşturur */
export async function createServer(data: CreateServerRequest) {
  return apiClient<Server>("/servers", {
    method: "POST",
    body: data,
  });
}

/** Davet koduyla sunucuya katılır */
export async function joinServer(inviteCode: string) {
  return apiClient<Server>("/servers/join", {
    method: "POST",
    body: { invite_code: inviteCode },
  });
}

/** Sunucu detayını getirir */
export async function getServer(serverId: string) {
  return apiClient<Server>(`/servers/${serverId}`);
}

/** Sunucu bilgisini günceller (isim, invite_required, livekit credentials) */
export async function updateServer(
  serverId: string,
  data: {
    name?: string;
    invite_required?: boolean;
    livekit_url?: string;
    livekit_key?: string;
    livekit_secret?: string;
  }
) {
  return apiClient<Server>(`/servers/${serverId}`, {
    method: "PATCH",
    body: data,
  });
}

/** Sunucuyu siler (sadece owner) */
export async function deleteServer(serverId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}`, {
    method: "DELETE",
  });
}

/** Sunucudan ayrılır (owner ayrılamaz) */
export async function leaveServer(serverId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/leave`, {
    method: "POST",
  });
}

/** LiveKit ayarlarını getirir (URL + tip bilgisi, secret yok) */
export async function getLiveKitSettings(serverId: string) {
  return apiClient<{ url: string; is_platform_managed: boolean }>(
    `/servers/${serverId}/livekit`
  );
}

/** Kullanıcının sunucu listesini sıralar (per-user) */
export async function reorderServers(items: { id: string; position: number }[]) {
  return apiClient<ServerListItem[]>("/servers/reorder", {
    method: "PATCH",
    body: { items },
  });
}

/** Sunucu ikonu yükler — multipart/form-data */
export async function uploadServerIcon(serverId: string, file: File) {
  const formData = new FormData();
  formData.append("file", file);

  return apiClient<Server>(`/servers/${serverId}/icon`, {
    method: "POST",
    body: formData,
  });
}
