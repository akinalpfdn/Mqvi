/**
 * Device Manager — Cihaz yasam dongusu yonetimi.
 *
 * Her tarayici/Electron instance bagimsiz bir kriptografik cihazdir.
 * Bu modul cihaz kaydi, anahtar yukleme ve prekey yenileme islerini yonetir.
 *
 * Yasam dongusu:
 * 1. App acilir → getLocalDeviceId() ile mevcut cihaz kontrol edilir
 * 2. Cihaz yoksa → registerNewDevice() ile yeni cihaz kaydedilir
 * 3. Cihaz varsa → refreshPreKeys() ile prekey havuzu kontrol edilir
 * 4. Logout → clearDevice() ile tum E2EE verisi temizlenir
 *
 * Device ID:
 * 16-byte rastgele hex string, IndexedDB metadata store'unda saklanir.
 * Ayni kullanicinin farkli cihazlari farkli device ID'lere sahiptir.
 */

import * as keyStorage from "./keyStorage";
import * as signalProtocol from "./signalProtocol";
import * as e2eeApi from "../api/e2ee";
import { PREKEY_BATCH_SIZE, PREKEY_LOW_THRESHOLD } from "./types";

// ──────────────────────────────────
// Device Identification
// ──────────────────────────────────

/**
 * Bu cihazin device ID'sini doner.
 * IndexedDB metadata store'unda "deviceId" key'i altinda saklanir.
 *
 * @returns Device ID veya null (henuz kaydedilmemis cihaz)
 */
export async function getLocalDeviceId(): Promise<string | null> {
  return keyStorage.getMetadata<string>("deviceId");
}

/**
 * 16-byte rastgele device ID uretir.
 * Ornek: "a3b4c5d6e7f8a1b2c3d4e5f6a7b8c9d0"
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
 * Yeni cihaz kaydeder.
 *
 * Tam akis:
 * 1. Device ID uret
 * 2. Tum E2EE anahtarlarini uret (identity, signed prekey, OTP keys)
 * 3. Sunucuya kaydet (prekey bundle upload)
 * 4. Lokal metadata kaydet
 *
 * @param userId - Kullanicinin ID'si
 * @param displayName - Cihaz adi (opsiyonel, "Chrome - Windows" gibi)
 * @returns Device ID
 */
export async function registerNewDevice(
  userId: string,
  displayName?: string
): Promise<string> {
  // 1. Device ID uret
  const deviceId = generateDeviceId();

  // 2. E2EE anahtarlarini uret
  const keys = await signalProtocol.generateAllKeys();

  // 3. Sunucuya kaydet
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

  // 4. Lokal metadata kaydet
  await keyStorage.setMetadata("deviceId", deviceId);
  await keyStorage.saveRegistrationData({
    registrationId: keys.registrationId,
    deviceId,
    userId,
    createdAt: Date.now(),
  });

  // Sonraki prekey batch icin baslangic ID'sini kaydet
  await keyStorage.setMetadata(
    "nextPrekeyId",
    PREKEY_BATCH_SIZE + 1
  );

  return deviceId;
}

// ──────────────────────────────────
// PreKey Management
// ──────────────────────────────────

/**
 * Prekey havuzunu kontrol eder ve gerekirse yeniler.
 *
 * Sunucudan prekey_low event'i geldiginde veya periyodik olarak cagrilir.
 * Sunucudaki prekey sayisi threshold'un altindaysa yeni batch yukler.
 *
 * @param deviceId - Bu cihazin device ID'si
 */
export async function refreshPreKeys(deviceId: string): Promise<void> {
  // Sunucudaki prekey sayisini kontrol et
  const countResponse = await e2eeApi.getPrekeyCount(deviceId);
  if (!countResponse.success || !countResponse.data) return;

  const serverCount = countResponse.data.count;

  if (serverCount >= PREKEY_LOW_THRESHOLD) {
    return; // Yeterli prekey var
  }

  // Yeni batch uret
  const nextId =
    (await keyStorage.getMetadata<number>("nextPrekeyId")) ??
    PREKEY_BATCH_SIZE + 1;

  const newPreKeys = await signalProtocol.generateMorePreKeys(
    nextId,
    PREKEY_BATCH_SIZE
  );

  // Sunucuya yukle
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

  // Sonraki batch icin ID guncelle
  await keyStorage.setMetadata("nextPrekeyId", nextId + PREKEY_BATCH_SIZE);
}

/**
 * Signed prekey rotate eder.
 *
 * Periyodik olarak cagrilir (ornegin haftada bir).
 * Yeni signed prekey uretir, sunucuya yukler, eski key'i siler.
 *
 * @param deviceId - Bu cihazin device ID'si
 */
export async function rotateSignedPreKey(deviceId: string): Promise<void> {
  // Mevcut signed prekey ID'sini bul
  const allSignedPreKeys = await keyStorage.getAllSignedPreKeys();
  const currentMaxId = allSignedPreKeys.reduce(
    (max, spk) => Math.max(max, spk.id),
    0
  );
  const newId = currentMaxId + 1;

  // Yeni signed prekey uret
  const newSignedPreKey = await signalProtocol.rotateSignedPreKey(newId);

  // Sunucuya yukle
  const response = await e2eeApi.updateSignedPrekey(deviceId, {
    signed_prekey: newSignedPreKey.publicKey,
    signed_prekey_id: newSignedPreKey.id,
    signed_prekey_signature: newSignedPreKey.signature,
  });

  if (!response.success) {
    console.error("[deviceManager] Failed to rotate signed prekey:", response.error);
    return;
  }

  // Eski signed prekey'leri temizle (son 2'yi tut — transit mesajlar icin)
  const sortedKeys = allSignedPreKeys.sort((a, b) => b.id - a.id);
  for (let i = 2; i < sortedKeys.length; i++) {
    await keyStorage.deleteSignedPreKey(sortedKeys[i].id);
  }
}

// ──────────────────────────────────
// Device Cleanup
// ──────────────────────────────────

/**
 * Bu cihazi sunucudan siler.
 *
 * Logout'ta cagrilir — sunucudaki device kaydini ve prekey'leri siler.
 * Lokal E2EE verisi ayri olarak clearDevice() ile temizlenir.
 *
 * @param deviceId - Silinecek cihaz ID'si
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
 * Tum lokal E2EE verisini temizler.
 *
 * Logout'ta cagrilir. IndexedDB'deki tum anahtarlar,
 * session'lar, sender key'ler ve cache temizlenir.
 * Bu islem geri alinamaz.
 */
export async function clearDevice(): Promise<void> {
  await keyStorage.clearAllE2EEData();
}

// ──────────────────────────────────
// Helpers
// ──────────────────────────────────

/**
 * Varsayilan cihaz adi uretir.
 *
 * Browser/OS bilgisinden anlamli bir isim cikarir.
 * Ornek: "Chrome - Windows", "Firefox - macOS", "Electron - Windows"
 */
function getDefaultDeviceName(): string {
  const ua = navigator.userAgent;

  // Electron mu?
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
