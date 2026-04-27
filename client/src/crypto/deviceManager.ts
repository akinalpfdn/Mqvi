/**
 * Device Manager — device lifecycle management.
 *
 * Each browser/Electron instance is an independent cryptographic device.
 * This module manages device registration, key upload, and prekey refresh.
 *
 * Lifecycle:
 * 1. App opens → existing device is checked via getLocalDeviceId()
 * 2. If no device → registerNewDevice() registers a new device
 * 3. If device exists → refreshPreKeys() checks the prekey pool
 * 4. Logout → clearDevice() wipes all E2EE data
 *
 * Device ID:
 * 16-byte random hex string, stored in the IndexedDB metadata store.
 * Different devices of the same user have different device IDs.
 */

import * as keyStorage from "./keyStorage";
import * as signalProtocol from "./signalProtocol";
import { toBase64 } from "./signalProtocol";
import * as e2eeApi from "../api/e2ee";
import { PREKEY_BATCH_SIZE, PREKEY_LOW_THRESHOLD } from "./types";

// ──────────────────────────────────
// Device Identification
// ──────────────────────────────────

/**
 * Returns this device's device ID.
 * Stored in the IndexedDB metadata store under the "deviceId" key.
 *
 * @returns Device ID, or null (device not yet registered)
 */
export async function getLocalDeviceId(): Promise<string | null> {
  return keyStorage.getMetadata<string>("deviceId");
}

/**
 * Generates a 16-byte random device ID.
 * Example: "a3b4c5d6e7f8a1b2c3d4e5f6a7b8c9d0"
 */
function generateDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ──────────────────────────────────
// Device Registration
// ──────────────────────────────────

/**
 * Registers a new device.
 *
 * Full flow:
 * 1. Generate a device ID
 * 2. Generate all E2EE keys (identity, signed prekey, OTP keys)
 * 3. Register with the server (prekey bundle upload)
 * 4. Save local metadata
 *
 * @param userId - User's ID
 * @param displayName - Device name (optional, e.g. "Chrome - Windows")
 * @returns Device ID
 */
export async function registerNewDevice(
  userId: string,
  displayName?: string
): Promise<string> {
  // 1. Generate device ID
  const deviceId = generateDeviceId();

  // 2. Generate E2EE keys
  const keys = await signalProtocol.generateAllKeys();

  // 3. Register with the server
  const response = await e2eeApi.registerDevice({
    device_id: deviceId,
    display_name: displayName ?? getDefaultDeviceName(),
    identity_key: keys.identityPublicKey,
    signing_key: keys.signingPublicKey,
    signed_prekey: keys.signedPreKey.publicKey,
    signed_prekey_id: keys.signedPreKey.id,
    signed_prekey_signature: keys.signedPreKey.signature,
    registration_id: keys.registrationId,
    one_time_prekeys: keys.oneTimePreKeys.map((pk) => ({
      prekey_id: pk.id,
      public_key: pk.publicKey,
    })),
  });

  if (!response.success) {
    throw new Error(
      `Device registration failed: ${response.error ?? "unknown error"}`
    );
  }

  // 4. Save local metadata
  await keyStorage.setMetadata("deviceId", deviceId);
  await keyStorage.saveRegistrationData({
    registrationId: keys.registrationId,
    deviceId,
    userId,
    createdAt: Date.now(),
  });

  // Save the starting ID for the next prekey batch
  await keyStorage.setMetadata(
    "nextPrekeyId",
    PREKEY_BATCH_SIZE + 1
  );

  return deviceId;
}

// ──────────────────────────────────
// Device Re-registration
// ──────────────────────────────────

/**
 * Registers the device with the server using the existing keys in IndexedDB.
 *
 * Used by reRegisterDevice:
 * Re-registration with the same device ID (server DB loss or recovery restore)
 *
 * @param deviceId - Device ID to register
 */
async function registerExistingKeys(deviceId: string): Promise<void> {
  const identityKeyPair = await keyStorage.getIdentityKeyPair();
  if (!identityKeyPair) throw new Error("Identity key pair not found in IndexedDB");

  const signingKeyPair = await keyStorage.getSigningKeyPair();
  if (!signingKeyPair) throw new Error("Signing key pair not found in IndexedDB");

  const registration = await keyStorage.getRegistrationData();
  if (!registration) throw new Error("Registration data not found in IndexedDB");

  const signedPreKeys = await keyStorage.getAllSignedPreKeys();
  if (signedPreKeys.length === 0) throw new Error("No signed prekey found in IndexedDB");

  const latestSignedPreKey = signedPreKeys.sort((a, b) => b.id - a.id)[0];

  const response = await e2eeApi.registerDevice({
    device_id: deviceId,
    display_name: getDefaultDeviceName(),
    identity_key: toBase64(identityKeyPair.publicKey),
    signing_key: toBase64(signingKeyPair.publicKey),
    signed_prekey: toBase64(latestSignedPreKey.publicKey),
    signed_prekey_id: latestSignedPreKey.id,
    signed_prekey_signature: toBase64(latestSignedPreKey.signature),
    registration_id: registration.registrationId,
    one_time_prekeys: [],
  });

  if (!response.success) {
    throw new Error(`Device registration failed: ${response.error ?? "unknown error"}`);
  }
}

/**
 * Re-registers the device with the server using existing keys.
 *
 * Called when the device is registered in IndexedDB but unknown to the server.
 * The existing identity + signed prekey are read from IndexedDB and uploaded
 * to the server again (UPSERT — updates if the same device_id exists).
 *
 * @param deviceId - Local device ID (from IndexedDB)
 */
export async function reRegisterDevice(deviceId: string): Promise<void> {
  await registerExistingKeys(deviceId);
}

/**
 * After a recovery restore, registers with the server using a new device ID.
 *
 * Why a new device ID:
 * Two devices sharing the same device ID CANNOT do self-fanout
 * (the sender skips its own device ID → the other device receives no envelope).
 * With a new device ID, each device works independently.
 *
 * Legacy device ID for old messages:
 * The (old) device ID from the backup is added to the "legacyDeviceIds" list.
 * During envelope matching, both current and legacy IDs are tried.
 * This way, old messages can also be read (+ messageCache comes from the backup).
 *
 * @returns New device ID
 */
export async function registerRestoredDevice(): Promise<string> {
  // Store the old device ID from the backup as legacy
  const oldDeviceId = await keyStorage.getMetadata<string>("deviceId");
  if (oldDeviceId) {
    const existing = await keyStorage.getMetadata<string[]>("legacyDeviceIds") ?? [];
    if (!existing.includes(oldDeviceId)) {
      await keyStorage.setMetadata("legacyDeviceIds", [...existing, oldDeviceId]);
    }
  }

  const newDeviceId = generateDeviceId();

  // Update the device ID in IndexedDB
  await keyStorage.setMetadata("deviceId", newDeviceId);

  const registration = await keyStorage.getRegistrationData();
  if (registration) {
    await keyStorage.saveRegistrationData({
      ...registration,
      deviceId: newDeviceId,
      createdAt: Date.now(),
    });
  }

  // Clear old sessions — invalid with a different device ID.
  // The new device will establish fresh sessions with other devices via PreKey messages.
  await keyStorage.clearAllSessions();

  // Register with the server
  await registerExistingKeys(newDeviceId);

  // Prekey ID counter: the value from the backup must be preserved.
  // The backup metadata "nextPrekeyId" already contains the correct value.
  // If we overwrite it with PREKEY_BATCH_SIZE + 1, refreshPreKeys generates
  // new prekeys colliding with old IDs and overwrites the backup's private
  // keys → X3DH shared secret mismatch → OperationError.
  const restoredNextId = await keyStorage.getMetadata<number>("nextPrekeyId");
  if (!restoredNextId || restoredNextId < PREKEY_BATCH_SIZE + 1) {
    await keyStorage.setMetadata("nextPrekeyId", PREKEY_BATCH_SIZE + 1);
  }

  return newDeviceId;
}

/**
 * Returns the legacy device IDs.
 * After a recovery restore, old device IDs are stored here.
 * In envelope matching, current + legacy IDs are tried together.
 */
export async function getLegacyDeviceIds(): Promise<string[]> {
  return (await keyStorage.getMetadata<string[]>("legacyDeviceIds")) ?? [];
}

// ──────────────────────────────────
// PreKey Management
// ──────────────────────────────────

/**
 * Checks the prekey pool and refreshes it if needed.
 *
 * Called when a prekey_low event arrives from the server, or periodically.
 * If the prekey count on the server is below the threshold, uploads a new batch.
 *
 * @param deviceId - This device's device ID
 */
export async function refreshPreKeys(deviceId: string): Promise<void> {
  // Check the prekey count on the server
  const countResponse = await e2eeApi.getPrekeyCount(deviceId);
  if (!countResponse.success || !countResponse.data) return;

  const serverCount = countResponse.data.count;

  if (serverCount >= PREKEY_LOW_THRESHOLD) {
    return; // Enough prekeys available
  }

  // Generate a new batch
  const nextId =
    (await keyStorage.getMetadata<number>("nextPrekeyId")) ??
    PREKEY_BATCH_SIZE + 1;

  const newPreKeys = await signalProtocol.generateMorePreKeys(
    nextId,
    PREKEY_BATCH_SIZE
  );

  // Upload to the server
  const uploadResponse = await e2eeApi.uploadPrekeys(deviceId, {
    one_time_prekeys: newPreKeys.map((pk) => ({
      prekey_id: pk.id,
      public_key: pk.publicKey,
    })),
  });

  if (!uploadResponse.success) {
    console.error("[deviceManager] Failed to upload prekeys:", uploadResponse.error);
    return;
  }

  // Update the ID for the next batch
  await keyStorage.setMetadata("nextPrekeyId", nextId + PREKEY_BATCH_SIZE);
}

/**
 * Rotates the signed prekey.
 *
 * Called periodically (for example, weekly).
 * Generates a new signed prekey, uploads it to the server, and deletes the old key.
 *
 * @param deviceId - This device's device ID
 */
export async function rotateSignedPreKey(deviceId: string): Promise<void> {
  // Find the current signed prekey ID
  const allSignedPreKeys = await keyStorage.getAllSignedPreKeys();
  const currentMaxId = allSignedPreKeys.reduce(
    (max, spk) => Math.max(max, spk.id),
    0
  );
  const newId = currentMaxId + 1;

  // Generate a new signed prekey
  const newSignedPreKey = await signalProtocol.rotateSignedPreKey(newId);

  // Upload to the server
  const response = await e2eeApi.updateSignedPrekey(deviceId, {
    signed_prekey: newSignedPreKey.publicKey,
    signed_prekey_id: newSignedPreKey.id,
    signed_prekey_signature: newSignedPreKey.signature,
  });

  if (!response.success) {
    console.error("[deviceManager] Failed to rotate signed prekey:", response.error);
    return;
  }

  // Clean up old signed prekeys (keep the last 2 — for in-flight messages)
  const sortedKeys = allSignedPreKeys.sort((a, b) => b.id - a.id);
  for (let i = 2; i < sortedKeys.length; i++) {
    await keyStorage.deleteSignedPreKey(sortedKeys[i].id);
  }
}

// ──────────────────────────────────
// Device Cleanup
// ──────────────────────────────────

/**
 * Removes this device from the server.
 *
 * Called on logout — deletes the device record and prekeys on the server.
 * Local E2EE data is wiped separately via clearDevice().
 *
 * @param deviceId - Device ID to delete
 */
export async function removeDeviceFromServer(
  deviceId: string
): Promise<void> {
  const response = await e2eeApi.removeDevice(deviceId);
  if (!response.success) {
    console.error("[deviceManager] Failed to remove device:", response.error);
  }
}

/**
 * Clears all local E2EE data.
 *
 * Called on logout. All keys, sessions, sender keys, and cache in
 * IndexedDB are cleared. This operation is irreversible.
 */
export async function clearDevice(): Promise<void> {
  await keyStorage.clearAllE2EEData();
}

// ──────────────────────────────────
// Helpers
// ──────────────────────────────────

/**
 * Generates a default device name.
 *
 * Derives a meaningful name from browser/OS info.
 * Examples: "Chrome - Windows", "Firefox - macOS", "Electron - Windows"
 */
function getDefaultDeviceName(): string {
  const ua = navigator.userAgent;

  // Electron?
  if ("electronAPI" in window) {
    if (ua.includes("Windows")) return "mqvi Desktop - Windows";
    if (ua.includes("Mac")) return "mqvi Desktop - macOS";
    if (ua.includes("Linux")) return "mqvi Desktop - Linux";
    return "mqvi Desktop";
  }

  // Browser
  let browser = "Browser";
  if (ua.includes("Firefox")) browser = "Firefox";
  else if (ua.includes("Edg/")) browser = "Edge";
  else if (ua.includes("Chrome")) browser = "Chrome";
  else if (ua.includes("Safari")) browser = "Safari";

  let os = "";
  if (ua.includes("Windows")) os = " - Windows";
  else if (ua.includes("Mac")) os = " - macOS";
  else if (ua.includes("Linux")) os = " - Linux";
  else if (ua.includes("Android")) os = " - Android";
  else if (ua.includes("iPhone") || ua.includes("iPad")) os = " - iOS";

  return `${browser}${os}`;
}
