/**
 * E2EE API — Device, PreKey Bundle, Key Backup ve Group Session endpoint'leri.
 *
 * Bu modul, E2EE cihaz yonetimi ve anahtar degisimi icin
 * backend endpoint'lerine HTTP istekleri gonderir.
 *
 * Endpoint'ler:
 *
 * Device:
 *   POST   /api/devices                           — Cihaz kaydet + prekey bundle yukle
 *   GET    /api/devices                           — Kendi cihazlarini listele
 *   DELETE /api/devices/{deviceId}                — Cihaz sil
 *   POST   /api/devices/{deviceId}/prekeys        — One-time prekey'ler yukle
 *   PUT    /api/devices/{deviceId}/signed-prekey   — Signed prekey rotate et
 *   GET    /api/devices/{deviceId}/prekey-count    — Kalan prekey sayisi
 *
 * User Devices (public):
 *   GET    /api/users/{userId}/devices            — Kullanicinin public cihaz listesi
 *   GET    /api/users/{userId}/prekey-bundles     — X3DH icin prekey bundle'lari
 *
 * Key Backup:
 *   PUT    /api/e2ee/key-backup                   — Sifreli anahtar yedegi yukle
 *   GET    /api/e2ee/key-backup                   — Sifreli anahtar yedegini indir
 *   DELETE /api/e2ee/key-backup                   — Anahtar yedegini sil
 *
 * Group Sessions:
 *   POST   /api/servers/{sId}/channels/{cId}/group-sessions  — Sender Key kaydet
 *   GET    /api/servers/{sId}/channels/{cId}/group-sessions  — Grup session'lari al
 */

import { apiClient } from "./client";
import type {
  DeviceInfo,
  DevicePublicInfo,
  PreKeyBundleResponse,
  KeyBackupResponse,
  ChannelGroupSessionResponse,
} from "../types";

// ──────────────────────────────────
// Device Management
// ──────────────────────────────────

/**
 * Yeni cihaz kaydeder ve prekey bundle yukler.
 * POST /api/devices
 */
export function registerDevice(req: {
  device_id: string;
  display_name: string;
  identity_key: string;
  signed_prekey: string;
  signed_prekey_id: number;
  signed_prekey_signature: string;
  registration_id: number;
  one_time_prekeys: Array<{ prekey_id: number; public_key: string }>;
}) {
  return apiClient<{ device_id: string }>("/devices", {
    method: "POST",
    body: req,
  });
}

/**
 * Kendi cihazlarini listeler.
 * GET /api/devices
 */
export function listMyDevices() {
  return apiClient<DeviceInfo[]>("/devices");
}

/**
 * Cihaz siler.
 * DELETE /api/devices/{deviceId}
 */
export function removeDevice(deviceId: string) {
  return apiClient<null>(`/devices/${deviceId}`, {
    method: "DELETE",
  });
}

/**
 * Ek one-time prekey'ler yukler.
 * POST /api/devices/{deviceId}/prekeys
 */
export function uploadPrekeys(
  deviceId: string,
  req: {
    one_time_prekeys: Array<{ prekey_id: number; public_key: string }>;
  }
) {
  return apiClient<null>(`/devices/${deviceId}/prekeys`, {
    method: "POST",
    body: req,
  });
}

/**
 * Signed prekey rotate eder.
 * PUT /api/devices/{deviceId}/signed-prekey
 */
export function updateSignedPrekey(
  deviceId: string,
  req: {
    signed_prekey: string;
    signed_prekey_id: number;
    signed_prekey_signature: string;
  }
) {
  return apiClient<null>(`/devices/${deviceId}/signed-prekey`, {
    method: "PUT",
    body: req,
  });
}

/**
 * Sunucudaki prekey sayisini doner.
 * GET /api/devices/{deviceId}/prekey-count
 */
export function getPrekeyCount(deviceId: string) {
  return apiClient<{ count: number }>(`/devices/${deviceId}/prekey-count`);
}

// ──────────────────────────────────
// User Devices (Public)
// ──────────────────────────────────

/**
 * Bir kullanicinin public cihaz listesini doner.
 * GET /api/users/{userId}/devices
 */
export function listUserDevices(userId: string) {
  return apiClient<DevicePublicInfo[]>(`/users/${userId}/devices`);
}

/**
 * Bir kullanicinin tum cihazlari icin prekey bundle'larini doner.
 * X3DH key agreement icin gerekli.
 * GET /api/users/{userId}/prekey-bundles
 */
export function fetchPreKeyBundles(userId: string) {
  return apiClient<PreKeyBundleResponse[]>(`/users/${userId}/prekey-bundles`);
}

// ──────────────────────────────────
// Key Backup
// ──────────────────────────────────

/**
 * Sifreli anahtar yedegi yukler/gunceller.
 * PUT /api/e2ee/key-backup
 */
export function uploadKeyBackup(req: {
  version: number;
  algorithm: string;
  encrypted_data: string;
  nonce: string;
  salt: string;
}) {
  return apiClient<null>("/e2ee/key-backup", {
    method: "PUT",
    body: req,
  });
}

/**
 * Sifreli anahtar yedegini indirir.
 * GET /api/e2ee/key-backup
 *
 * Backup yoksa 200 + null data doner (404 degil).
 */
export function downloadKeyBackup() {
  return apiClient<KeyBackupResponse | null>("/e2ee/key-backup");
}

/**
 * Anahtar yedegini siler.
 * DELETE /api/e2ee/key-backup
 */
export function deleteKeyBackup() {
  return apiClient<null>("/e2ee/key-backup", {
    method: "DELETE",
  });
}

// ──────────────────────────────────
// Group Sessions (Server-scoped)
// ──────────────────────────────────

/**
 * Kanala Sender Key grup oturumu kaydeder.
 * POST /api/servers/{serverId}/channels/{channelId}/group-sessions?device_id={deviceId}
 */
export function uploadGroupSession(
  serverId: string,
  channelId: string,
  deviceId: string,
  req: {
    session_id: string;
    session_data: string;
  }
) {
  return apiClient<null>(
    `/servers/${serverId}/channels/${channelId}/group-sessions?device_id=${deviceId}`,
    {
      method: "POST",
      body: req,
    }
  );
}

/**
 * Kanaldaki tum aktif grup oturumlarini doner.
 * GET /api/servers/{serverId}/channels/{channelId}/group-sessions
 */
export function fetchGroupSessions(serverId: string, channelId: string) {
  return apiClient<ChannelGroupSessionResponse[]>(
    `/servers/${serverId}/channels/${channelId}/group-sessions`
  );
}
