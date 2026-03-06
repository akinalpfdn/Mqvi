/**
 * Key Backup — Recovery password ile anahtar yedekleme/geri yukleme.
 *
 * Matrix/Element modelinden esinlenmistir:
 * 1. Kullanici opsiyonel bir "recovery password" belirler
 * 2. PBKDF2 (1M iterations, SHA-256) ile AES-256-GCM anahtari turetilir
 * 3. Tum E2EE anahtarlari bu anahtarla sifrelenir
 * 4. Sifreli blob sunucuya yuklenir
 * 5. Yeni cihazda recovery password girilirse tum anahtarlar geri yuklenir
 *
 * Guvenlik:
 * - Sunucu sadece sifreli blob saklar — recovery password'u BILMEZ
 * - PBKDF2 1M iteration — brute-force koruması (~1 saniye per deneme)
 * - AES-256-GCM — authenticated encryption (tamper detection)
 * - Salt her backup icin rastgele — rainbow table koruması
 *
 * Alternatif: Kullanici recovery password belirlemezse,
 * yeni cihazda eski mesajlar gorunmez (sadece yeni mesajlar decrypt edilir).
 */

import * as keyStorage from "./keyStorage";
import { toBase64, fromBase64 } from "./signalProtocol";

// ──────────────────────────────────
// Constants
// ──────────────────────────────────

/** PBKDF2 iteration sayisi — yuksek = daha guvenli ama daha yavas */
const PBKDF2_ITERATIONS = 1_000_000;

/** Backup algorithm identifier */
const BACKUP_ALGORITHM = "aes-256-gcm";

/** Backup version */
const BACKUP_VERSION = 1;

// ──────────────────────────────────
// Backup Types
// ──────────────────────────────────

/**
 * Backup icerigi — sifrelenmeden onceki veri.
 * Tum E2EE anahtarlarini ve session'lari icerir.
 */
type BackupContents = {
  version: number;
  identity: {
    publicKey: string; // base64
    privateKey: string; // base64
  };
  signing: {
    publicKey: string;
    privateKey: string;
  };
  registration: {
    registrationId: number;
    deviceId: string;
    userId: string;
  };
  signedPreKeys: Array<{
    id: number;
    publicKey: string;
    privateKey: string;
    signature: string;
    createdAt: number;
  }>;
  sessions: Array<{
    userId: string;
    deviceId: string;
    state: string; // JSON stringified SessionState (with base64 encoded bytes)
    createdAt: number;
    updatedAt: number;
  }>;
  senderKeys: Array<{
    channelId: string;
    senderUserId: string;
    senderDeviceId: string;
    distributionId: string;
    chainKey: string;
    initialChainKey: string;
    publicSigningKey: string;
    iteration: number;
    createdAt: number;
  }>;
  /** One-time prekey'ler — X3DH icin kritik. Backup'ta olmalidir yoksa
   *  restore sonrasi PreKey mesajlari decrypt edilemez (3-DH vs 4-DH uyumsuzlugu). */
  preKeys: Array<{
    id: number;
    publicKey: string;
    privateKey: string;
  }>;
  trustedIdentities: Array<{
    userId: string;
    deviceId: string;
    identityKey: string;
    firstSeen: number;
    verified: boolean;
  }>;
  /** Prekey ID counter — restore sonrasi yeni prekey'lerin eski ID'lere denk gelmemesi icin */
  nextPrekeyId?: number;
  /** Decrypt edilmis mesaj cache'i — restore sonrasi eski mesajlar okunabilir */
  messageCache?: Array<{
    messageId: string;
    channelId: string;
    dmChannelId: string | null;
    content: string;
    timestamp: number;
  }>;
};

// ──────────────────────────────────
// Backup Creation
// ──────────────────────────────────

/**
 * Recovery password ile E2EE anahtar yedegi olusturur.
 *
 * Akis:
 * 1. IndexedDB'deki tum anahtarlar ve session'lar okunur
 * 2. JSON olarak serialize edilir
 * 3. Recovery password'den PBKDF2 ile AES key turetilir
 * 4. AES-256-GCM ile sifrelenir
 * 5. Sifreli blob + nonce + salt donulur (sunucuya yuklenecek)
 *
 * @param recoveryPassword - Kullanicinin sectigi recovery password
 * @returns Sunucuya yuklenecek backup verisi
 */
export async function createBackup(recoveryPassword: string): Promise<{
  version: number;
  algorithm: string;
  encryptedData: string; // base64
  nonce: string;         // base64
  salt: string;          // base64
}> {
  // 1. Tum E2EE verisini topla
  const contents = await collectBackupContents();

  // 2. JSON serialize
  const plaintext = new TextEncoder().encode(JSON.stringify(contents));

  // 3. PBKDF2 ile key turet
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const derivedKey = await deriveKeyFromPassword(recoveryPassword, salt);

  // 4. AES-256-GCM ile sifrele
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    derivedKey as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    cryptoKey,
    plaintext as BufferSource
  );

  return {
    version: BACKUP_VERSION,
    algorithm: BACKUP_ALGORITHM,
    encryptedData: toBase64(new Uint8Array(encrypted)),
    nonce: toBase64(nonce),
    salt: toBase64(salt),
  };
}

// ──────────────────────────────────
// Backup Restoration
// ──────────────────────────────────

/**
 * Recovery password ile E2EE anahtarlarini geri yukler.
 *
 * Akis:
 * 1. Sunucudan sifreli backup alinir
 * 2. Recovery password'den ayni PBKDF2 ile AES key turetilir
 * 3. AES-256-GCM ile cozulur
 * 4. JSON deserialize edilir
 * 5. Tum anahtarlar IndexedDB'ye yazilir
 *
 * @param backup - Sunucudan alinan sifreli backup
 * @param recoveryPassword - Kullanicinin girdigi recovery password
 * @returns true ise basarili, false ise sifre yanlis
 */
export async function restoreFromBackup(
  backup: {
    encryptedData: string;
    nonce: string;
    salt: string;
  },
  recoveryPassword: string
): Promise<boolean> {
  try {
    // 1. PBKDF2 ile key turet
    const salt = fromBase64(backup.salt);
    const derivedKey = await deriveKeyFromPassword(recoveryPassword, salt);

    // 2. AES-256-GCM ile coz
    const nonce = fromBase64(backup.nonce);
    const encryptedData = fromBase64(backup.encryptedData);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      derivedKey as BufferSource,
      "AES-GCM",
      false,
      ["decrypt"]
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource },
      cryptoKey,
      encryptedData as BufferSource
    );

    // 3. JSON parse
    const contents: BackupContents = JSON.parse(
      new TextDecoder().decode(decrypted)
    );

    // 4. IndexedDB'ye yaz
    await importBackupContents(contents);

    return true;
  } catch {
    // Decrypt basarisiz — sifre yanlis veya veri bozuk
    return false;
  }
}

// ──────────────────────────────────
// Internal: Collect & Import
// ──────────────────────────────────

/**
 * IndexedDB'deki tum E2EE verisini toplar.
 */
async function collectBackupContents(): Promise<BackupContents> {
  const identity = await keyStorage.getIdentityKeyPair();
  const signing = await keyStorage.getSigningKeyPair();
  const registration = await keyStorage.getRegistrationData();

  if (!identity || !signing || !registration) {
    throw new Error("E2EE keys not initialized — cannot create backup");
  }

  const signedPreKeys = await keyStorage.getAllSignedPreKeys();
  const preKeys = await keyStorage.getAllPreKeys();
  const sessions = await keyStorage.getAllSessions();
  const senderKeys = await keyStorage.getAllSenderKeys();
  const trustedIdentities = await keyStorage.getAllTrustedIdentities();
  const cachedMessages = await keyStorage.getAllCachedMessages();
  const nextPrekeyId = await keyStorage.getMetadata<number>("nextPrekeyId");

  return {
    version: BACKUP_VERSION,
    identity: {
      publicKey: toBase64(identity.publicKey),
      privateKey: toBase64(identity.privateKey),
    },
    signing: {
      publicKey: toBase64(signing.publicKey),
      privateKey: toBase64(signing.privateKey),
    },
    registration: {
      registrationId: registration.registrationId,
      deviceId: registration.deviceId,
      userId: registration.userId,
    },
    signedPreKeys: signedPreKeys.map((spk) => ({
      id: spk.id,
      publicKey: toBase64(spk.publicKey),
      privateKey: toBase64(spk.privateKey),
      signature: toBase64(spk.signature),
      createdAt: spk.createdAt,
    })),
    preKeys: preKeys.map((pk) => ({
      id: pk.id,
      publicKey: toBase64(pk.publicKey),
      privateKey: toBase64(pk.privateKey),
    })),
    sessions: sessions.map((s) => ({
      userId: s.userId,
      deviceId: s.deviceId,
      state: JSON.stringify(serializeSessionState(s.state)),
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    senderKeys: senderKeys.map((sk) => ({
      channelId: sk.channelId,
      senderUserId: sk.senderUserId,
      senderDeviceId: sk.senderDeviceId,
      distributionId: sk.distributionId,
      chainKey: toBase64(sk.chainKey),
      initialChainKey: sk.initialChainKey ? toBase64(sk.initialChainKey) : "",
      publicSigningKey: toBase64(sk.publicSigningKey),
      iteration: sk.iteration,
      createdAt: sk.createdAt,
    })),
    trustedIdentities: trustedIdentities.map((ti) => ({
      userId: ti.userId,
      deviceId: ti.deviceId,
      identityKey: toBase64(ti.identityKey),
      firstSeen: ti.firstSeen,
      verified: ti.verified,
    })),
    nextPrekeyId: nextPrekeyId ?? undefined,
    messageCache: cachedMessages.map((m) => ({
      messageId: m.messageId,
      channelId: m.channelId,
      dmChannelId: m.dmChannelId,
      content: m.content,
      timestamp: m.timestamp,
    })),
  };
}

/**
 * Backup icerigini IndexedDB'ye import eder.
 */
async function importBackupContents(contents: BackupContents): Promise<void> {
  // Mevcut message cache'i koru — restore crypto key'leri degistirir
  // ama daha once decrypt edilmis mesajlarin plaintext'i korunmali.
  // Ozellikle ayni tarayicida restore yapildiginda: mevcut cache silinirse
  // eski mesajlar bir daha okunamaz (ratchet state degismis olabilir).
  const existingCache = await keyStorage.getAllCachedMessages();

  // Crypto key'leri temizle (messageCache dahil — sonra geri yazacagiz)
  await keyStorage.clearAllE2EEData();

  // Identity key pair
  await keyStorage.saveIdentityKeyPair({
    publicKey: fromBase64(contents.identity.publicKey),
    privateKey: fromBase64(contents.identity.privateKey),
  });

  // Signing key pair
  await keyStorage.saveSigningKeyPair({
    publicKey: fromBase64(contents.signing.publicKey),
    privateKey: fromBase64(contents.signing.privateKey),
  });

  // Registration data
  await keyStorage.saveRegistrationData({
    registrationId: contents.registration.registrationId,
    deviceId: contents.registration.deviceId,
    userId: contents.registration.userId,
    createdAt: Date.now(),
  });

  // deviceId'yi metadata store'a da yaz — getLocalDeviceId() buradan okur.
  // registerNewDevice() bunu yapar ama importBackupContents yazmazsa
  // restore sonrası localDeviceId null kalır → device management bozulur.
  await keyStorage.setMetadata("deviceId", contents.registration.deviceId);

  // nextPrekeyId'yi restore et — yeni prekey uretiminin eski ID'lere denk
  // gelmemesi icin (eski prekey private key'lerinin ezilmesini onler).
  if (contents.nextPrekeyId) {
    await keyStorage.setMetadata("nextPrekeyId", contents.nextPrekeyId);
  }

  // Signed prekeys
  for (const spk of contents.signedPreKeys) {
    await keyStorage.saveSignedPreKey({
      id: spk.id,
      publicKey: fromBase64(spk.publicKey),
      privateKey: fromBase64(spk.privateKey),
      signature: fromBase64(spk.signature),
      createdAt: spk.createdAt,
    });
  }

  // One-time prekeys — X3DH icin kritik
  if (contents.preKeys && contents.preKeys.length > 0) {
    await keyStorage.savePreKeys(
      contents.preKeys.map((pk) => ({
        id: pk.id,
        publicKey: fromBase64(pk.publicKey),
        privateKey: fromBase64(pk.privateKey),
      }))
    );
  }

  // Sessions
  for (const s of contents.sessions) {
    const state = deserializeSessionState(JSON.parse(s.state));
    await keyStorage.saveSession({
      userId: s.userId,
      deviceId: s.deviceId,
      state,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
  }

  // Sender keys
  for (const sk of contents.senderKeys) {
    await keyStorage.saveSenderKey({
      channelId: sk.channelId,
      senderUserId: sk.senderUserId,
      senderDeviceId: sk.senderDeviceId,
      distributionId: sk.distributionId,
      chainKey: fromBase64(sk.chainKey),
      initialChainKey: sk.initialChainKey ? fromBase64(sk.initialChainKey) : fromBase64(sk.chainKey),
      publicSigningKey: fromBase64(sk.publicSigningKey),
      iteration: sk.iteration,
      createdAt: sk.createdAt,
    });
  }

  // Trusted identities
  for (const ti of contents.trustedIdentities) {
    await keyStorage.saveTrustedIdentity({
      userId: ti.userId,
      deviceId: ti.deviceId,
      identityKey: fromBase64(ti.identityKey),
      firstSeen: ti.firstSeen,
      verified: ti.verified,
    });
  }

  // Message cache — mevcut cache + backup cache'i birlestir.
  // Mevcut cache oncelikli (ayni tarayicida restore → eski cache korunur).
  // Backup'taki cache sadece mevcut cache'te olmayan mesajlar icin eklenir.
  const existingIds = new Set(existingCache.map((m) => m.messageId));
  const mergedCache = [...existingCache];

  if (contents.messageCache) {
    for (const m of contents.messageCache) {
      if (!existingIds.has(m.messageId)) {
        mergedCache.push({
          messageId: m.messageId,
          channelId: m.channelId,
          dmChannelId: m.dmChannelId,
          content: m.content,
          timestamp: m.timestamp,
        });
      }
    }
  }

  if (mergedCache.length > 0) {
    await keyStorage.cacheDecryptedMessages(mergedCache);
  }
}

// ──────────────────────────────────
// Internal: Session State Serialization
// ──────────────────────────────────

/**
 * SessionState'deki Uint8Array'leri base64'e cevirir.
 * JSON.stringify Uint8Array'i dogru serialize edemez, bu yuzden
 * once base64'e cevirip sonra JSON'a yaziyoruz.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeSessionState(state: any): any {
  if (state === null || state === undefined) return state;
  if (state instanceof Uint8Array) return { __b64: toBase64(state) };
  if (Array.isArray(state)) return state.map(serializeSessionState);
  if (typeof state === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(state)) {
      result[key] = serializeSessionState(value);
    }
    return result;
  }
  return state;
}

/**
 * Serialized SessionState'deki base64'leri Uint8Array'e geri cevirir.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deserializeSessionState(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data === "object" && "__b64" in data) {
    return fromBase64(data.__b64);
  }
  if (Array.isArray(data)) return data.map(deserializeSessionState);
  if (typeof data === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = deserializeSessionState(value);
    }
    return result;
  }
  return data;
}

// ──────────────────────────────────
// Internal: PBKDF2
// ──────────────────────────────────

/**
 * Recovery password'den AES-256 key turetir.
 *
 * PBKDF2 (Password-Based Key Derivation Function 2):
 * - Yavas hash fonksiyonu — brute-force'u zorlastirir
 * - 1M iteration ≈ ~1 saniye per deneme (offline attack senaryosu)
 * - Salt her backup icin farkli — ayni sifre farkli key uretir
 *
 * @param password - Kullanicinin recovery password'u
 * @param salt - 32-byte rastgele salt
 * @returns 32-byte AES-256 key
 */
async function deriveKeyFromPassword(
  password: string,
  salt: Uint8Array
): Promise<Uint8Array> {
  const passwordBytes = new TextEncoder().encode(password);

  const baseKey = await crypto.subtle.importKey(
    "raw",
    passwordBytes as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    256 // 32 bytes
  );

  return new Uint8Array(derivedBits);
}
