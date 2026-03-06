/**
 * Sender Key Protocol — Grup/kanal sifreleme katmani.
 *
 * Signal'in Sender Key protokolu, grup mesajlasma icin optimize edilmistir.
 * N uyeli bir grupta, her mesaj tek bir sifreleme islemi ile N cihaza gonderilir
 * (her biri icin ayri sifreleme yerine).
 *
 * Calisma prensibi:
 * 1. Gonderici bir "sender key" olusturur (chainKey + signingKey)
 * 2. Bu sender key'i kanal uyelerine Signal 1:1 session'lari uzerinden dagitir
 *    (SenderKeyDistributionMessage)
 * 3. Gonderici mesaji tek seferde sifreler → tek ciphertext
 * 4. Tum alicilar ayni ciphertext'i kendi inbound sender key'leri ile cozer
 *
 * Key rotation:
 * - Uye cikarildiginda yeni sender key olusturulur
 * - Her SENDER_KEY_ROTATION_MESSAGES (100) mesajda otomatik rotation
 * - Her SENDER_KEY_ROTATION_DAYS (7) gunde otomatik rotation
 *
 * Referans: Signal'in Sender Key spec'i (libsignal-protocol icindeki
 * SenderKeyMessage ve SenderKeyDistributionMessage protokolleri)
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as keyStorage from "./keyStorage";
import { toBase64, fromBase64 } from "./signalProtocol";
import {
  type StoredSenderKey,
  type SenderKeyDistributionData,
  type SenderKeyMessage,
  SENDER_KEY_ROTATION_MESSAGES,
  SENDER_KEY_ROTATION_DAYS,
  HKDF_INFO,
} from "./types";

// ──────────────────────────────────
// Sender Key Distribution
// ──────────────────────────────────

/**
 * Yeni Sender Key distribution olusturur (outbound).
 *
 * Kanal icin yeni bir sender key uretir ve dagitim mesaji doner.
 * Bu dagitim mesaji, kanal uyelerine Signal 1:1 session'lari
 * uzerinden sifrelenerek gonderilir.
 *
 * @param channelId - Kanal ID'si
 * @param userId - Bu cihazin kullanici ID'si
 * @param deviceId - Bu cihazin device ID'si
 * @returns Base64 encoded distribution message (sunucuya yuklenmek icin)
 */
export async function createDistribution(
  channelId: string,
  userId: string,
  deviceId: string
): Promise<SenderKeyDistributionData> {
  // Rastgele chain key ve distribution ID uret
  const chainKey = crypto.getRandomValues(new Uint8Array(32));
  const signingPrivateKey = ed25519.utils.randomSecretKey();
  const signingPublicKey = ed25519.getPublicKey(signingPrivateKey);
  const distributionId = generateDistributionId();

  // Outbound sender key olarak kaydet
  const senderKey: StoredSenderKey = {
    channelId,
    senderUserId: userId,
    senderDeviceId: deviceId,
    distributionId,
    chainKey,
    initialChainKey: new Uint8Array(chainKey),
    publicSigningKey: signingPublicKey,
    iteration: 0,
    createdAt: Date.now(),
  };

  await keyStorage.saveSenderKey(senderKey);

  // Signing private key'i ayri metadata olarak kaydet
  // (sadece outbound icin — biz gonderiyoruz, imzalamamiz lazim)
  await keyStorage.setMetadata(
    `sk_signing:${channelId}:${userId}:${deviceId}`,
    signingPrivateKey
  );

  return {
    distributionId,
    chainKey: toBase64(chainKey),
    publicSigningKey: toBase64(signingPublicKey),
    iteration: 0,
  };
}

/**
 * Gelen Sender Key distribution'i isle (inbound).
 *
 * Baska bir kullanicinin sender key'ini alir ve kaydeder.
 * Bundan sonra o kullanicinin gonderdigi grup mesajlarini
 * bu key ile cozebiliriz.
 *
 * @param channelId - Kanal ID'si
 * @param senderUserId - Gondericinin kullanici ID'si
 * @param senderDeviceId - Gondericinin cihaz ID'si
 * @param distribution - Distribution message (decode edilmis)
 */
export async function processDistribution(
  channelId: string,
  senderUserId: string,
  senderDeviceId: string,
  distribution: SenderKeyDistributionData
): Promise<void> {
  const chainKey = fromBase64(distribution.chainKey);
  const senderKey: StoredSenderKey = {
    channelId,
    senderUserId,
    senderDeviceId,
    distributionId: distribution.distributionId,
    chainKey,
    initialChainKey: new Uint8Array(chainKey),
    publicSigningKey: fromBase64(distribution.publicSigningKey),
    iteration: distribution.iteration,
    createdAt: Date.now(),
  };

  await keyStorage.saveSenderKey(senderKey);
}

// ──────────────────────────────────
// Group Encryption
// ──────────────────────────────────

/**
 * Grup mesaji sifreler (Sender Key).
 *
 * Tek bir encrypt islemi — tum kanal uyeleri ayni ciphertext'i alir.
 * Her mesajda chain key HMAC ratchet ile ilerletilir.
 *
 * @param channelId - Kanal ID'si
 * @param userId - Bu cihazin kullanici ID'si
 * @param deviceId - Bu cihazin device ID'si
 * @param plaintext - Sifrelenmemis mesaj (UTF-8)
 * @returns Sifreli mesaj + metadata
 */
export async function encryptGroupMessage(
  channelId: string,
  userId: string,
  deviceId: string,
  plaintext: string
): Promise<SenderKeyMessage> {
  const senderKey = await keyStorage.getSenderKey(
    channelId,
    userId,
    deviceId
  );

  if (!senderKey) {
    throw new Error(
      `No sender key found for channel ${channelId}. ` +
        "Create a distribution first."
    );
  }

  // Rotation gerekli mi kontrol et
  if (needsRotation(senderKey)) {
    throw new Error(
      `Sender key for channel ${channelId} needs rotation. ` +
        "Create a new distribution."
    );
  }

  // Chain key'den message key turet (HMAC ratchet)
  const messageKey = deriveGroupMessageKey(senderKey.chainKey);
  const newChainKey = advanceChainKey(senderKey.chainKey);

  // AES-256-GCM ile sifrele
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await groupAesGcmEncrypt(
    messageKey,
    plaintextBytes,
    senderKey.distributionId,
    senderKey.iteration
  );

  const iteration = senderKey.iteration;

  // Sender key guncelle
  senderKey.chainKey = newChainKey;
  senderKey.iteration++;
  await keyStorage.saveSenderKey(senderKey);

  // Imza ekle
  const signingPrivateKey = await keyStorage.getMetadata<Uint8Array>(
    `sk_signing:${channelId}:${userId}:${deviceId}`
  );

  let signedCiphertext: Uint8Array;
  if (signingPrivateKey) {
    // Ciphertext'i Ed25519 ile imzala — mesaj butunlugu + gonderici dogrulamasi
    const sig = ed25519.sign(
      new Uint8Array(ciphertext),
      new Uint8Array(signingPrivateKey)
    );
    // signature (64) + ciphertext
    signedCiphertext = new Uint8Array(sig.length + ciphertext.byteLength);
    signedCiphertext.set(sig, 0);
    signedCiphertext.set(new Uint8Array(ciphertext), sig.length);
  } else {
    signedCiphertext = new Uint8Array(ciphertext);
  }

  return {
    distributionId: senderKey.distributionId,
    iteration,
    ciphertext: toBase64(signedCiphertext),
  };
}

/**
 * Grup mesaji cozer (Sender Key).
 *
 * Gondericinin sender key'i ile ciphertext'i cozer.
 * Chain key, gondericinin iterasyonuna kadar ilerletilir.
 *
 * @param channelId - Kanal ID'si
 * @param senderUserId - Gondericinin kullanici ID'si
 * @param senderDeviceId - Gondericinin cihaz ID'si
 * @param message - Sifreli mesaj
 * @returns Cozulmus plaintext (UTF-8)
 */
export async function decryptGroupMessage(
  channelId: string,
  senderUserId: string,
  senderDeviceId: string,
  message: SenderKeyMessage
): Promise<string> {
  const senderKey = await keyStorage.getSenderKey(
    channelId,
    senderUserId,
    senderDeviceId
  );

  if (!senderKey) {
    throw new Error(
      `No sender key found for ${senderUserId}:${senderDeviceId} ` +
        `in channel ${channelId}. Distribution not received.`
    );
  }

  if (senderKey.distributionId !== message.distributionId) {
    throw new Error(
      `Distribution ID mismatch: expected ${senderKey.distributionId}, ` +
        `got ${message.distributionId}`
    );
  }

  const rawData = fromBase64(message.ciphertext);

  // Imza dogrula + ciphertext ayir
  let ciphertext: Uint8Array;
  if (rawData.length > 64) {
    const signature = rawData.slice(0, 64);
    ciphertext = rawData.slice(64);

    // Ed25519 imza dogrulama
    try {
      const valid = ed25519.verify(
        signature,
        ciphertext,
        senderKey.publicSigningKey
      );
      if (!valid) {
        throw new Error("Sender key signature verification failed");
      }
    } catch {
      throw new Error("Sender key signature verification failed");
    }
  } else {
    ciphertext = rawData;
  }

  // Chain key'i gondericinin iterasyonuna kadar ilerlet
  let currentChainKey = senderKey.chainKey;
  let currentIteration = senderKey.iteration;

  /**
   * Out-of-order mesaj destegi:
   *
   * Mesajin iterasyonu mevcut iterasyonun gerisindeyse, iki durum var:
   * 1. Tarihsel mesaj — fetchMessages ile gelen eski mesaj (en yaygin)
   * 2. Replay attack — ayni mesajin tekrar gonderilmesi
   *
   * initialChainKey varsa, orijinal chain key'den bastan tureterek
   * eski iterasyonun message key'ini elde edebiliriz. Bu durumda
   * stored state GUNCELLENMEZ — sadece decrypt yapilir.
   *
   * initialChainKey yoksa (eski format sender key), decrypt yapilamaz.
   */
  const isOutOfOrder = message.iteration < currentIteration;

  if (isOutOfOrder) {
    if (!senderKey.initialChainKey) {
      throw new Error(
        `Message iteration ${message.iteration} is behind current ` +
          `iteration ${currentIteration}. No initial chain key for re-derivation.`
      );
    }

    // Bastan tureterek eski iterasyonun chain key'ine ulas
    let rewindChainKey = senderKey.initialChainKey;
    for (let i = 0; i < message.iteration; i++) {
      rewindChainKey = advanceChainKey(rewindChainKey);
    }

    const messageKey = deriveGroupMessageKey(rewindChainKey);

    // Decrypt — stored state GUNCELLENMEZ (tarihsel mesaj)
    const plaintext = await groupAesGcmDecrypt(
      messageKey,
      ciphertext,
      message.distributionId,
      message.iteration
    );

    return new TextDecoder().decode(plaintext);
  }

  // Normal akis: mesaj iterasyonu >= mevcut iterasyon
  while (currentIteration < message.iteration) {
    currentChainKey = advanceChainKey(currentChainKey);
    currentIteration++;
  }

  // Message key turet
  const messageKey = deriveGroupMessageKey(currentChainKey);

  // Bir sonraki iterasyon icin chain key'i ilerlet
  const nextChainKey = advanceChainKey(currentChainKey);

  // Decrypt
  const plaintext = await groupAesGcmDecrypt(
    messageKey,
    ciphertext,
    message.distributionId,
    message.iteration
  );

  // Sender key guncelle
  senderKey.chainKey = nextChainKey;
  senderKey.iteration = message.iteration + 1;
  await keyStorage.saveSenderKey(senderKey);

  return new TextDecoder().decode(plaintext);
}

// ──────────────────────────────────
// Key Rotation
// ──────────────────────────────────

/**
 * Sender key rotation gerekli mi kontrol eder.
 *
 * Rotation kosullari:
 * 1. Mesaj sayisi SENDER_KEY_ROTATION_MESSAGES'i asmis
 * 2. Yas SENDER_KEY_ROTATION_DAYS'i asmis
 *
 * Public versiyon (needsRotationCheck) channelEncryption tarafindan
 * kullanilir — ensureSenderKeyForDecryption icinde key durumu kontrol edilir.
 */
export function needsRotationCheck(senderKey: StoredSenderKey): boolean {
  return needsRotation(senderKey);
}

function needsRotation(senderKey: StoredSenderKey): boolean {
  // Mesaj sayisi kontrolu
  if (senderKey.iteration >= SENDER_KEY_ROTATION_MESSAGES) {
    return true;
  }

  // Yas kontrolu
  const ageMs = Date.now() - senderKey.createdAt;
  const maxAgeMs = SENDER_KEY_ROTATION_DAYS * 24 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs) {
    return true;
  }

  return false;
}

/**
 * Belirli bir kanal icin sender key rotation gerekli mi kontrol eder.
 * Disaridan erisilebilir — e2eeStore tarafindan kullanilir.
 */
export async function needsSenderKeyRotation(
  channelId: string,
  userId: string,
  deviceId: string
): Promise<boolean> {
  const senderKey = await keyStorage.getSenderKey(
    channelId,
    userId,
    deviceId
  );

  if (!senderKey) return true; // Key yoksa olusturulmali
  return needsRotation(senderKey);
}

/**
 * Belirli bir kanalin tum sender key'lerini temizler.
 * Kanal silindiginde veya uyelik cikarildiginda cagrilir.
 */
export async function clearChannelSenderKeys(
  channelId: string
): Promise<void> {
  await keyStorage.deleteAllSenderKeysForChannel(channelId);
}

// ──────────────────────────────────
// Internal Helpers
// ──────────────────────────────────

/**
 * Chain key'den message key turetir.
 *
 * HMAC(chainKey, HKDF_INFO.SENDER_KEY) → 32-byte message key
 * Deterministik — ayni chainKey her zaman ayni messageKey uretir.
 */
function deriveGroupMessageKey(chainKey: Uint8Array): Uint8Array {
  return hmac(sha256, chainKey, new TextEncoder().encode(HKDF_INFO.SENDER_KEY));
}

/**
 * Chain key'i bir adim ilerletir (HMAC ratchet).
 *
 * HMAC(chainKey, 0x01) → yeni chainKey
 * Forward secrecy: Yeni chain key'den eski message key turetilmez.
 */
function advanceChainKey(chainKey: Uint8Array): Uint8Array {
  return hmac(sha256, chainKey, new Uint8Array([0x01]));
}

/**
 * Grup mesaji icin AES-256-GCM sifreleme.
 * Associated data olarak distributionId ve iteration kullanilir.
 */
async function groupAesGcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  distributionId: string,
  iteration: number
): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ad = new TextEncoder().encode(`${distributionId}:${iteration}`);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ad },
    cryptoKey,
    plaintext as BufferSource
  );

  // iv (12) + encrypted (includes 16-byte auth tag)
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), iv.length);
  return result.buffer;
}

/**
 * Grup mesaji icin AES-256-GCM cozme.
 */
async function groupAesGcmDecrypt(
  key: Uint8Array,
  data: Uint8Array,
  distributionId: string,
  iteration: number
): Promise<ArrayBuffer> {
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const ad = new TextEncoder().encode(`${distributionId}:${iteration}`);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"]
  );

  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: ad },
    cryptoKey,
    ciphertext as BufferSource
  );
}

/**
 * Rastgele distribution ID uretir (16 byte hex).
 */
function generateDistributionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
