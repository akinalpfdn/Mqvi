/**
 * E2EE API — Device management, PreKey Bundles, Key Backup, and Group Sessions.
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

/** Register new device and upload prekey bundle. POST /api/devices */
export function registerDevice(req: {
  device_id: string;
  display_name: string;
  identity_key: string;
  signing_key: string;
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

/** List own devices. GET /api/devices */
export function listMyDevices() {
  return apiClient<DeviceInfo[]>("/devices");
}

/** Delete a device. DELETE /api/devices/{deviceId} */
export function removeDevice(deviceId: string) {
  return apiClient<null>(`/devices/${deviceId}`, {
    method: "DELETE",
  });
}

/** Upload additional one-time prekeys. POST /api/devices/{deviceId}/prekeys */
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

/** Rotate signed prekey. PUT /api/devices/{deviceId}/signed-prekey */
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

/** Get remaining prekey count. GET /api/devices/{deviceId}/prekey-count */
export function getPrekeyCount(deviceId: string) {
  return apiClient<{ count: number }>(`/devices/${deviceId}/prekey-count`);
}

// ──────────────────────────────────
// User Devices (Public)
// ──────────────────────────────────

/** Get a user's public device list. GET /api/users/{userId}/devices */
export function listUserDevices(userId: string) {
  return apiClient<DevicePublicInfo[]>(`/users/${userId}/devices`);
}

/** Fetch prekey bundles for all of a user's devices (for X3DH). GET /api/users/{userId}/prekey-bundles */
export function fetchPreKeyBundles(userId: string) {
  return apiClient<PreKeyBundleResponse[]>(`/users/${userId}/prekey-bundles`);
}

// ──────────────────────────────────
// Key Backup
// ──────────────────────────────────

/** Upload/update encrypted key backup. PUT /api/e2ee/key-backup */
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

/** Download encrypted key backup. Returns null data if no backup exists (not 404). */
export function downloadKeyBackup() {
  return apiClient<KeyBackupResponse | null>("/e2ee/key-backup");
}

/** Delete key backup. DELETE /api/e2ee/key-backup */
export function deleteKeyBackup() {
  return apiClient<null>("/e2ee/key-backup", {
    method: "DELETE",
  });
}

// ──────────────────────────────────
// Group Sessions (Server-scoped)
// ──────────────────────────────────

/** Save Sender Key group session. POST /api/servers/{serverId}/channels/{channelId}/group-sessions */
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

/** Fetch all active group sessions for a channel. GET /api/servers/{serverId}/channels/{channelId}/group-sessions */
export function fetchGroupSessions(serverId: string, channelId: string) {
  return apiClient<ChannelGroupSessionResponse[]>(
    `/servers/${serverId}/channels/${channelId}/group-sessions`
  );
}
