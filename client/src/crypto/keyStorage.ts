/**
 * E2EE Key Storage — IndexedDB wrapper.
 *
 * Tum E2EE anahtar materiali IndexedDB'de saklanir.
 * `idb` kutuphanesi IndexedDB'nin callback-based API'sini
 * Promise-based API'ye cevirir (async/await kullanilabilir).
 *
 * Object store'lar:
 * - identity: Identity key pair (tek kayit, cihaz basina)
 * - signing: Ed25519 signing key pair (identity key'den turetilmis)
 * - registration: Cihaz kayit bilgileri (deviceId, registrationId)
 * - signedPreKeys: Signed prekey'ler (id bazli)
 * - preKeys: One-time prekey'ler (id bazli)
 * - sessions: Signal Double Ratchet session'lari (userId+deviceId bazli)
 * - senderKeys: Sender Key session'lari (channelId+userId+deviceId bazli)
 * - trustedIdentities: Guvenilen cihaz kimlikleri (userId+deviceId bazli)
 * - messageCache: Decrypt edilmis mesaj cache'i (channelId index'li)
 * - metadata: Genel metadata (key-value)
 *
 * Guvenlik notu:
 * IndexedDB browser'in sandboxed storage'idir. Veriler disk'e sifrelenmeden
 * yazilir, ancak OS-level FDE (Full Disk Encryption) ile korunur.
 * Bu, Signal Desktop ve Element'in de kullandigi yaklasimdir.
 */

import { openDB, type IDBPDatabase } from "idb";
import type {
  StoredIdentityKeyPair,
  StoredSigningKeyPair,
  StoredSignedPreKey,
  StoredPreKey,
  StoredSession,
  StoredSenderKey,
  TrustedIdentity,
  CachedDecryptedMessage,
  RegistrationData,
} from "./types";

// ──────────────────────────────────
// Database Schema
// ──────────────────────────────────

const DB_NAME = "mqvi_e2ee";
const DB_VERSION = 1;

/**
 * IndexedDB baglantisi — lazy initialization.
 *
 * openDB sadece ilk erisimde cagrilir, sonraki erisimler
 * ayni db instance'ini kullanir. Singleton pattern.
 */
let dbInstance: IDBPDatabase | null = null;

async function getDB(): Promise<IDBPDatabase> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB(DB_NAME, DB_VERSION, {
    /**
     * upgrade callback — DB ilk olusturulurken veya versiyon arttiginda calisir.
     *
     * IndexedDB'de schema degisiklikleri sadece upgrade transaction icinde yapilabilir.
     * Her object store bir tablo gibidir. keyPath primary key'i belirtir.
     * Index'ler sorgu performansi icin eklenir (SQL INDEX gibi).
     */
    upgrade(db) {
      // Identity key pair — tek kayit, "primary" key ile
      if (!db.objectStoreNames.contains("identity")) {
        db.createObjectStore("identity");
      }

      // Ed25519 signing key pair
      if (!db.objectStoreNames.contains("signing")) {
        db.createObjectStore("signing");
      }

      // Cihaz kayit bilgileri
      if (!db.objectStoreNames.contains("registration")) {
        db.createObjectStore("registration");
      }

      // Signed prekey'ler — id bazli
      if (!db.objectStoreNames.contains("signedPreKeys")) {
        db.createObjectStore("signedPreKeys", { keyPath: "id" });
      }

      // One-time prekey'ler — id bazli
      if (!db.objectStoreNames.contains("preKeys")) {
        db.createObjectStore("preKeys", { keyPath: "id" });
      }

      // Signal session'lari — compositeKey fonksiyonu ile out-of-line key
      if (!db.objectStoreNames.contains("sessions")) {
        db.createObjectStore("sessions");
      }

      // Sender Key session'lari — out-of-line key
      if (!db.objectStoreNames.contains("senderKeys")) {
        db.createObjectStore("senderKeys");
      }

      // Guvenilen cihaz kimlikleri — out-of-line key
      if (!db.objectStoreNames.contains("trustedIdentities")) {
        db.createObjectStore("trustedIdentities");
      }

      // Decrypt edilmis mesaj cache'i — messageId bazli, channelId index'li
      if (!db.objectStoreNames.contains("messageCache")) {
        const store = db.createObjectStore("messageCache", {
          keyPath: "messageId",
        });
        store.createIndex("byChannel", "channelId", { unique: false });
        store.createIndex("byDMChannel", "dmChannelId", { unique: false });
      }

      // Genel metadata (key-value)
      if (!db.objectStoreNames.contains("metadata")) {
        db.createObjectStore("metadata");
      }
    },
  });

  return dbInstance;
}

// ──────────────────────────────────
// Composite Key Helpers
// ──────────────────────────────────

/**
 * Signal session icin composite key uretir.
 * userId ve deviceId birlestirilerek benzersiz anahtar olusturur.
 */
function sessionKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

/**
 * Sender Key icin composite key uretir.
 * channelId, userId ve deviceId birlestirilerek benzersiz anahtar olusturur.
 */
function senderKeyKey(
  channelId: string,
  userId: string,
  deviceId: string
): string {
  return `${channelId}:${userId}:${deviceId}`;
}

/**
 * Trusted identity icin composite key uretir.
 */
function trustedIdentityKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

// ──────────────────────────────────
// Identity Key Operations
// ──────────────────────────────────

/**
 * Identity key pair'i IndexedDB'ye kaydeder.
 * Cihaz basina tek kayit — "primary" key ile saklanir.
 */
export async function saveIdentityKeyPair(
  keyPair: StoredIdentityKeyPair
): Promise<void> {
  const db = await getDB();
  await db.put("identity", keyPair, "primary");
}

/**
 * Identity key pair'i IndexedDB'den okur.
 * Yoksa null doner (yeni cihaz, henuz key uretilmemis).
 */
export async function getIdentityKeyPair(): Promise<StoredIdentityKeyPair | null> {
  const db = await getDB();
  const result = await db.get("identity", "primary");
  return (result as StoredIdentityKeyPair) ?? null;
}

// ──────────────────────────────────
// Signing Key Operations
// ──────────────────────────────────

/**
 * Ed25519 signing key pair'i kaydeder.
 * Identity key ile ayni seed'den turetilir.
 */
export async function saveSigningKeyPair(
  keyPair: StoredSigningKeyPair
): Promise<void> {
  const db = await getDB();
  await db.put("signing", keyPair, "primary");
}

/**
 * Ed25519 signing key pair'i okur.
 */
export async function getSigningKeyPair(): Promise<StoredSigningKeyPair | null> {
  const db = await getDB();
  const result = await db.get("signing", "primary");
  return (result as StoredSigningKeyPair) ?? null;
}

// ──────────────────────────────────
// Registration Data Operations
// ──────────────────────────────────

/**
 * Cihaz kayit bilgilerini kaydeder.
 */
export async function saveRegistrationData(
  data: RegistrationData
): Promise<void> {
  const db = await getDB();
  await db.put("registration", data, "primary");
}

/**
 * Cihaz kayit bilgilerini okur.
 */
export async function getRegistrationData(): Promise<RegistrationData | null> {
  const db = await getDB();
  const result = await db.get("registration", "primary");
  return (result as RegistrationData) ?? null;
}

// ──────────────────────────────────
// Signed PreKey Operations
// ──────────────────────────────────

/**
 * Signed prekey kaydeder.
 */
export async function saveSignedPreKey(
  preKey: StoredSignedPreKey
): Promise<void> {
  const db = await getDB();
  await db.put("signedPreKeys", preKey);
}

/**
 * Signed prekey okur (ID bazli).
 */
export async function getSignedPreKey(
  id: number
): Promise<StoredSignedPreKey | null> {
  const db = await getDB();
  const result = await db.get("signedPreKeys", id);
  return (result as StoredSignedPreKey) ?? null;
}

/**
 * Tum signed prekey'leri listeler.
 */
export async function getAllSignedPreKeys(): Promise<StoredSignedPreKey[]> {
  const db = await getDB();
  return (await db.getAll("signedPreKeys")) as StoredSignedPreKey[];
}

/**
 * Signed prekey siler (rotation sonrasi eski key'i temizlemek icin).
 */
export async function deleteSignedPreKey(id: number): Promise<void> {
  const db = await getDB();
  await db.delete("signedPreKeys", id);
}

// ──────────────────────────────────
// One-Time PreKey Operations
// ──────────────────────────────────

/**
 * Birden fazla one-time prekey kaydeder (batch upload sonrasi).
 *
 * IndexedDB transaction icinde yapilir — ya hepsi basarir ya hicbiri.
 * Bu, prekey ID'lerinin tutarli kalmasini saglar.
 */
export async function savePreKeys(preKeys: StoredPreKey[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("preKeys", "readwrite");
  for (const pk of preKeys) {
    await tx.store.put(pk);
  }
  await tx.done;
}

/**
 * One-time prekey okur (ID bazli).
 */
export async function getPreKey(id: number): Promise<StoredPreKey | null> {
  const db = await getDB();
  const result = await db.get("preKeys", id);
  return (result as StoredPreKey) ?? null;
}

/**
 * One-time prekey siler (X3DH'da tuketildikten sonra).
 */
export async function deletePreKey(id: number): Promise<void> {
  const db = await getDB();
  await db.delete("preKeys", id);
}

/**
 * Mevcut one-time prekey sayisini doner.
 */
export async function countPreKeys(): Promise<number> {
  const db = await getDB();
  return await db.count("preKeys");
}

/**
 * Tum one-time prekey'leri listeler.
 */
export async function getAllPreKeys(): Promise<StoredPreKey[]> {
  const db = await getDB();
  return (await db.getAll("preKeys")) as StoredPreKey[];
}

// ──────────────────────────────────
// Signal Session Operations
// ──────────────────────────────────

/**
 * Signal session kaydeder/gunceller.
 */
export async function saveSession(session: StoredSession): Promise<void> {
  const db = await getDB();
  const key = sessionKey(session.userId, session.deviceId);
  await db.put("sessions", session, key);
}

/**
 * Signal session okur.
 */
export async function getSession(
  userId: string,
  deviceId: string
): Promise<StoredSession | null> {
  const db = await getDB();
  const result = await db.get("sessions", sessionKey(userId, deviceId));
  return (result as StoredSession) ?? null;
}

/**
 * Signal session siler.
 */
export async function deleteSession(
  userId: string,
  deviceId: string
): Promise<void> {
  const db = await getDB();
  await db.delete("sessions", sessionKey(userId, deviceId));
}

/**
 * Bir kullanicinin tum session'larini siler.
 * Kullanici cihaz degistirdiginde veya identity key rotasyonunda kullanilir.
 */
export async function deleteAllSessionsForUser(
  userId: string
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("sessions", "readwrite");
  const keys = await tx.store.getAllKeys();

  for (const key of keys) {
    if (typeof key === "string" && key.startsWith(`${userId}:`)) {
      await tx.store.delete(key);
    }
  }

  await tx.done;
}

/**
 * Belirli bir kullanici icin session var mi kontrol eder.
 */
export async function hasSession(
  userId: string,
  deviceId: string
): Promise<boolean> {
  const session = await getSession(userId, deviceId);
  return session !== null;
}

/**
 * Tum session'lari listeler.
 */
export async function getAllSessions(): Promise<StoredSession[]> {
  const db = await getDB();
  return (await db.getAll("sessions")) as StoredSession[];
}

/**
 * Tum Signal Protocol session'larini siler.
 * Recovery restore sonrasi cagrilir — eski session'lar yeni device ID ile gecersiz.
 */
export async function clearAllSessions(): Promise<void> {
  const db = await getDB();
  await db.clear("sessions");
}

// ──────────────────────────────────
// Sender Key Operations
// ──────────────────────────────────

/**
 * Sender Key kaydeder/gunceller.
 */
export async function saveSenderKey(senderKey: StoredSenderKey): Promise<void> {
  const db = await getDB();
  const key = senderKeyKey(
    senderKey.channelId,
    senderKey.senderUserId,
    senderKey.senderDeviceId
  );
  await db.put("senderKeys", senderKey, key);
}

/**
 * Sender Key okur.
 */
export async function getSenderKey(
  channelId: string,
  senderUserId: string,
  senderDeviceId: string
): Promise<StoredSenderKey | null> {
  const db = await getDB();
  const result = await db.get(
    "senderKeys",
    senderKeyKey(channelId, senderUserId, senderDeviceId)
  );
  return (result as StoredSenderKey) ?? null;
}

/**
 * Belirli bir kanalin tum sender key'lerini siler.
 * Kanal silindiginde veya key rotasyonunda kullanilir.
 */
export async function deleteAllSenderKeysForChannel(
  channelId: string
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("senderKeys", "readwrite");
  const keys = await tx.store.getAllKeys();

  for (const key of keys) {
    if (typeof key === "string" && key.startsWith(`${channelId}:`)) {
      await tx.store.delete(key);
    }
  }

  await tx.done;
}

/**
 * Tum sender key'leri listeler.
 */
export async function getAllSenderKeys(): Promise<StoredSenderKey[]> {
  const db = await getDB();
  return (await db.getAll("senderKeys")) as StoredSenderKey[];
}

// ──────────────────────────────────
// Trusted Identity Operations
// ──────────────────────────────────

/**
 * Guvenilen kimlik kaydeder/gunceller.
 */
export async function saveTrustedIdentity(
  identity: TrustedIdentity
): Promise<void> {
  const db = await getDB();
  const key = trustedIdentityKey(identity.userId, identity.deviceId);
  await db.put("trustedIdentities", identity, key);
}

/**
 * Guvenilen kimlik okur.
 */
export async function getTrustedIdentity(
  userId: string,
  deviceId: string
): Promise<TrustedIdentity | null> {
  const db = await getDB();
  const result = await db.get(
    "trustedIdentities",
    trustedIdentityKey(userId, deviceId)
  );
  return (result as TrustedIdentity) ?? null;
}

/**
 * Tum guvenilen kimlikleri listeler.
 */
export async function getAllTrustedIdentities(): Promise<TrustedIdentity[]> {
  const db = await getDB();
  return (await db.getAll("trustedIdentities")) as TrustedIdentity[];
}

// ──────────────────────────────────
// Message Cache Operations
// ──────────────────────────────────

/**
 * Decrypt edilmis mesaji cache'e yazar.
 */
export async function cacheDecryptedMessage(
  message: CachedDecryptedMessage
): Promise<void> {
  const db = await getDB();
  await db.put("messageCache", message);
}

/**
 * Tek bir decrypt edilmis mesaji ID ile okur.
 *
 * DM self-decrypt icin kullanilir: Signal Protocol, gondericinin
 * kendi cihazina envelope olusturmaz. Gonderi aninda plaintext
 * IndexedDB'ye yazilir ve sonradan bu fonksiyonla okunur.
 */
export async function getCachedDecryptedMessage(
  messageId: string
): Promise<CachedDecryptedMessage | null> {
  const db = await getDB();
  const result = await db.get("messageCache", messageId);
  return (result as CachedDecryptedMessage) ?? null;
}

/**
 * Birden fazla decrypt edilmis mesaji cache'e yazar.
 */
export async function cacheDecryptedMessages(
  messages: CachedDecryptedMessage[]
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("messageCache", "readwrite");
  for (const msg of messages) {
    await tx.store.put(msg);
  }
  await tx.done;
}

/**
 * Client-side mesaj arama.
 *
 * E2EE mesajlar sunucuda sifreli oldugundan, arama client-side yapilir.
 * IndexedDB'deki decrypt edilmis mesaj cache'i uzerinde string matching.
 *
 * @param channelId - Aranacak kanal ID'si
 * @param query - Arama terimi
 * @returns Eslesenlerin mesaj ID'leri
 */
export async function searchCachedMessages(
  channelId: string,
  query: string
): Promise<CachedDecryptedMessage[]> {
  const db = await getDB();
  const tx = db.transaction("messageCache", "readonly");
  const index = tx.store.index("byChannel");
  const results: CachedDecryptedMessage[] = [];

  const lowerQuery = query.toLowerCase();

  let cursor = await index.openCursor(channelId);
  while (cursor) {
    const msg = cursor.value as CachedDecryptedMessage;
    if (msg.content.toLowerCase().includes(lowerQuery)) {
      results.push(msg);
    }
    cursor = await cursor.continue();
  }

  return results;
}

/**
 * Tum decrypt edilmis mesaj cache'ini doner.
 * Backup'a dahil etmek icin kullanilir — restore sonrasi
 * eski mesajlar cache'den okunabilir.
 */
export async function getAllCachedMessages(): Promise<CachedDecryptedMessage[]> {
  const db = await getDB();
  return (await db.getAll("messageCache")) as CachedDecryptedMessage[];
}

/**
 * DM kanali icin client-side mesaj arama.
 */
export async function searchCachedDMMessages(
  dmChannelId: string,
  query: string
): Promise<CachedDecryptedMessage[]> {
  const db = await getDB();
  const tx = db.transaction("messageCache", "readonly");
  const index = tx.store.index("byDMChannel");
  const results: CachedDecryptedMessage[] = [];

  const lowerQuery = query.toLowerCase();

  let cursor = await index.openCursor(dmChannelId);
  while (cursor) {
    const msg = cursor.value as CachedDecryptedMessage;
    if (msg.content.toLowerCase().includes(lowerQuery)) {
      results.push(msg);
    }
    cursor = await cursor.continue();
  }

  return results;
}

// ──────────────────────────────────
// Metadata Operations
// ──────────────────────────────────

/**
 * Metadata degeri kaydeder (key-value).
 */
export async function setMetadata(key: string, value: unknown): Promise<void> {
  const db = await getDB();
  await db.put("metadata", value, key);
}

/**
 * Metadata degeri okur.
 */
export async function getMetadata<T>(key: string): Promise<T | null> {
  const db = await getDB();
  const result = await db.get("metadata", key);
  return (result as T) ?? null;
}

// ──────────────────────────────────
// Lifecycle Operations
// ──────────────────────────────────

/**
 * Tum E2EE verisini siler.
 *
 * Logout'ta cagrilir — cihazin tum kriptografik materyali temizlenir.
 * Bu islem geri alinamaz. Kullanicinin recovery password'u varsa
 * yeni cihazda backup'tan geri yukleyebilir.
 */
export async function clearAllE2EEData(): Promise<void> {
  const db = await getDB();

  const storeNames = [
    "identity",
    "signing",
    "registration",
    "signedPreKeys",
    "preKeys",
    "sessions",
    "senderKeys",
    "trustedIdentities",
    "messageCache",
    "metadata",
  ] as const;

  // Her store'u ayri transaction'da temizle
  for (const storeName of storeNames) {
    const tx = db.transaction(storeName, "readwrite");
    await tx.store.clear();
    await tx.done;
  }
}

/**
 * Lokal E2EE anahtarlarinin var olup olmadigini kontrol eder.
 *
 * App baslatildiginda cagrilir:
 * - true: Anahtarlar var → E2EE hazir
 * - false: Anahtarlar yok → yeni cihaz kurulumu gerekli
 */
export async function hasLocalKeys(): Promise<boolean> {
  const identity = await getIdentityKeyPair();
  const registration = await getRegistrationData();
  return identity !== null && registration !== null;
}

/**
 * DB baglantisini kapatir.
 * Test ve cleanup icin kullanilir.
 */
export async function closeDB(): Promise<void> {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
