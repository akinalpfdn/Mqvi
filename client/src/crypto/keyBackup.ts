/**
 * Key Backup — backup/restore E2EE keys with recovery password.
 *
 * Inspired by Matrix/Element model:
 * - User sets an optional recovery password
 * - PBKDF2 (1M iterations) derives AES-256-GCM key
 * - All E2EE keys are encrypted and uploaded to server
 * - Server only stores encrypted blob (never sees the password)
 * - New device restores keys by entering recovery password
 */

import * as keyStorage from "./keyStorage";
import { toBase64, fromBase64 } from "./signalProtocol";

// ──────────────────────────────────
// Constants
// ──────────────────────────────────

/** PBKDF2 iterations — higher = more secure but slower */
const PBKDF2_ITERATIONS = 1_000_000;

/** Backup algorithm identifier */
const BACKUP_ALGORITHM = "aes-256-gcm";

/** Backup version */
const BACKUP_VERSION = 1;

// ──────────────────────────────────
// Backup Types
// ──────────────────────────────────

/** Backup contents before encryption — all E2EE keys and sessions. */
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
  /** One-time prekeys — critical for X3DH. Without them, PreKey messages
   *  can't be decrypted after restore (3-DH vs 4-DH mismatch). */
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
  /** Prekey ID counter — prevents new prekeys from colliding with old IDs after restore */
  nextPrekeyId?: number;
  /** Decrypted message cache — allows reading old messages after restore */
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

/** Create an E2EE key backup encrypted with the recovery password. */
export async function createBackup(recoveryPassword: string): Promise<{
  version: number;
  algorithm: string;
  encryptedData: string; // base64
  nonce: string;         // base64
  salt: string;          // base64
}> {
  // 1. Collect all E2EE data
  const contents = await collectBackupContents();

  // 2. JSON serialize
  const plaintext = new TextEncoder().encode(JSON.stringify(contents));

  // 3. Derive key via PBKDF2
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const derivedKey = await deriveKeyFromPassword(recoveryPassword, salt);

  // 4. Encrypt with AES-256-GCM
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

/** Restore E2EE keys from backup using recovery password. Returns false if wrong password. */
export async function restoreFromBackup(
  backup: {
    encryptedData: string;
    nonce: string;
    salt: string;
  },
  recoveryPassword: string
): Promise<boolean> {
  try {
    // 1. Derive key via PBKDF2
    const salt = fromBase64(backup.salt);
    const derivedKey = await deriveKeyFromPassword(recoveryPassword, salt);

    // 2. Decrypt with AES-256-GCM
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

    // 4. Import to IndexedDB
    await importBackupContents(contents);

    return true;
  } catch {
    // Decrypt failed — wrong password or corrupted data
    return false;
  }
}

// ──────────────────────────────────
// Internal: Collect & Import
// ──────────────────────────────────

/** Collect all E2EE data from IndexedDB. */
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

/** Import backup contents into IndexedDB. */
async function importBackupContents(contents: BackupContents): Promise<void> {
  // Preserve existing message cache — previously decrypted messages must remain
  // readable since ratchet state may have changed after restore
  const existingCache = await keyStorage.getAllCachedMessages();

  // Clear crypto keys (including messageCache — will be re-written below)
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

  // Write deviceId to metadata store — getLocalDeviceId() reads from here.
  // Without this, localDeviceId stays null after restore → device management breaks.
  await keyStorage.setMetadata("deviceId", contents.registration.deviceId);

  // Restore nextPrekeyId to prevent new prekeys from overwriting old private keys
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

  // One-time prekeys — critical for X3DH
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

  // Merge existing cache + backup cache (existing takes priority)
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

/** Serialize SessionState Uint8Arrays to base64 for JSON compatibility. */
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

/** Deserialize base64 back to Uint8Array in SessionState. */
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

/** Derive AES-256 key from recovery password via PBKDF2 (1M iterations). */
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
