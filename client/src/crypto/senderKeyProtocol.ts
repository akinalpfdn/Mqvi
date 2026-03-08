/**
 * Sender Key Protocol — group/channel encryption layer.
 *
 * Optimized for group messaging: sender encrypts once, all N members
 * decrypt the same ciphertext with their inbound sender key.
 *
 * Flow: sender creates sender key → distributes via 1:1 Signal sessions →
 * encrypts with single operation → all recipients decrypt.
 *
 * Key rotation on member removal, every 100 messages, or every 7 days.
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

/** Create a new outbound Sender Key distribution for a channel. */
export async function createDistribution(
  channelId: string,
  userId: string,
  deviceId: string
): Promise<SenderKeyDistributionData> {
  // Generate random chain key and distribution ID
  const chainKey = crypto.getRandomValues(new Uint8Array(32));
  const signingPrivateKey = ed25519.utils.randomSecretKey();
  const signingPublicKey = ed25519.getPublicKey(signingPrivateKey);
  const distributionId = generateDistributionId();

  // Save as outbound sender key
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

  // Store signing private key separately (only needed for outbound signing)
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

/** Process an inbound Sender Key distribution. Saves the key for decrypting future messages from this sender. */
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

/** Encrypt a group message with Sender Key. Single encrypt for all channel members. */
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

  // Check if rotation needed
  if (needsRotation(senderKey)) {
    throw new Error(
      `Sender key for channel ${channelId} needs rotation. ` +
        "Create a new distribution."
    );
  }

  // Derive message key from chain key (HMAC ratchet)
  const messageKey = deriveGroupMessageKey(senderKey.chainKey);
  const newChainKey = advanceChainKey(senderKey.chainKey);

  // Encrypt with AES-256-GCM
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await groupAesGcmEncrypt(
    messageKey,
    plaintextBytes,
    senderKey.distributionId,
    senderKey.iteration
  );

  const iteration = senderKey.iteration;

  // Update sender key
  senderKey.chainKey = newChainKey;
  senderKey.iteration++;
  await keyStorage.saveSenderKey(senderKey);

  // Sign ciphertext
  const signingPrivateKey = await keyStorage.getMetadata<Uint8Array>(
    `sk_signing:${channelId}:${userId}:${deviceId}`
  );

  let signedCiphertext: Uint8Array;
  if (signingPrivateKey) {
    // Ed25519 signature for message integrity + sender authentication
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

/** Decrypt a group message using the sender's Sender Key. */
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

  // Verify signature + extract ciphertext
  let ciphertext: Uint8Array;
  if (rawData.length > 64) {
    const signature = rawData.slice(0, 64);
    ciphertext = rawData.slice(64);

    // Ed25519 signature verification
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

  // Advance chain key to sender's iteration
  let currentChainKey = senderKey.chainKey;
  let currentIteration = senderKey.iteration;

  // Out-of-order support: if message iteration is behind current,
  // re-derive from initialChainKey without updating stored state.
  // This handles historical messages from fetchMessages.
  const isOutOfOrder = message.iteration < currentIteration;

  if (isOutOfOrder) {
    if (!senderKey.initialChainKey) {
      throw new Error(
        `Message iteration ${message.iteration} is behind current ` +
          `iteration ${currentIteration}. No initial chain key for re-derivation.`
      );
    }

    // Re-derive from initial chain key to reach the old iteration
    let rewindChainKey = senderKey.initialChainKey;
    for (let i = 0; i < message.iteration; i++) {
      rewindChainKey = advanceChainKey(rewindChainKey);
    }

    const messageKey = deriveGroupMessageKey(rewindChainKey);

    // Decrypt without updating stored state (historical message)
    const plaintext = await groupAesGcmDecrypt(
      messageKey,
      ciphertext,
      message.distributionId,
      message.iteration
    );

    return new TextDecoder().decode(plaintext);
  }

  // Normal flow: message iteration >= current iteration
  while (currentIteration < message.iteration) {
    currentChainKey = advanceChainKey(currentChainKey);
    currentIteration++;
  }

  // Derive message key
  const messageKey = deriveGroupMessageKey(currentChainKey);

  // Advance chain key for next iteration
  const nextChainKey = advanceChainKey(currentChainKey);

  const plaintext = await groupAesGcmDecrypt(
    messageKey,
    ciphertext,
    message.distributionId,
    message.iteration
  );

  // Update sender key
  senderKey.chainKey = nextChainKey;
  senderKey.iteration = message.iteration + 1;
  await keyStorage.saveSenderKey(senderKey);

  return new TextDecoder().decode(plaintext);
}

// ──────────────────────────────────
// Key Rotation
// ──────────────────────────────────

/** Public wrapper for rotation check, used by channelEncryption. */
export function needsRotationCheck(senderKey: StoredSenderKey): boolean {
  return needsRotation(senderKey);
}

function needsRotation(senderKey: StoredSenderKey): boolean {
  // Message count check
  if (senderKey.iteration >= SENDER_KEY_ROTATION_MESSAGES) {
    return true;
  }

  // Age check
  const ageMs = Date.now() - senderKey.createdAt;
  const maxAgeMs = SENDER_KEY_ROTATION_DAYS * 24 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs) {
    return true;
  }

  return false;
}

/** Check if sender key rotation is needed for a channel. Used by e2eeStore. */
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

  if (!senderKey) return true; // No key — needs creation
  return needsRotation(senderKey);
}

/** Clear all sender keys for a channel (on deletion or membership removal). */
export async function clearChannelSenderKeys(
  channelId: string
): Promise<void> {
  await keyStorage.deleteAllSenderKeysForChannel(channelId);
}

// ──────────────────────────────────
// Internal Helpers
// ──────────────────────────────────

/** Derive message key from chain key. Deterministic: same chainKey → same messageKey. */
function deriveGroupMessageKey(chainKey: Uint8Array): Uint8Array {
  return hmac(sha256, chainKey, new TextEncoder().encode(HKDF_INFO.SENDER_KEY));
}

/** Advance chain key by one step (HMAC ratchet). Forward secrecy: old keys not derivable. */
function advanceChainKey(chainKey: Uint8Array): Uint8Array {
  return hmac(sha256, chainKey, new Uint8Array([0x01]));
}

/** AES-256-GCM encrypt for group messages. AD = distributionId:iteration. */
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

/** AES-256-GCM decrypt for group messages. */
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

/** Generate random distribution ID (16 byte hex). */
function generateDistributionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
