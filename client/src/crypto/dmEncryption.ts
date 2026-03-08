/**
 * DM Encryption — E2EE encrypt/decrypt layer for DM messages.
 *
 * Used by dmStore (sending) and useWebSocket (receiving).
 * Uses Signal Protocol primitives:
 * - Send: plaintext → EncryptedEnvelope[] (one per recipient device)
 * - Receive: EncryptedEnvelope[] → plaintext (for this device)
 *
 * Self-fanout: sender encrypts for own other devices so all
 * devices can see sent messages.
 *
 * On first message, recipient's prekey bundle is fetched and
 * X3DH session is established. Subsequent messages use existing
 * Double Ratchet session.
 */

import * as signalProtocol from "./signalProtocol";
import * as e2eeApi from "../api/e2ee";
import * as keyStorage from "./keyStorage";
import * as deviceManager from "./deviceManager";
import { decodePayload, type E2EEPayload } from "./e2eePayload";
import { useE2EEStore } from "../stores/e2eeStore";
import type { EncryptedEnvelope, PreKeyBundleResponse, DMMessage } from "../types";
import type { SignalWireMessage } from "./types";

// ──────────────────────────────────
// Sent Message Plaintext Cache
// ──────────────────────────────────

/**
 * FIFO plaintext cache for sent DM messages.
 *
 * Signal Protocol cannot create an envelope for the sender's own device
 * (no Double Ratchet session to self). So on WS echo, the sender cannot
 * decrypt its own message.
 *
 * Solution (Signal Desktop / WhatsApp model):
 * Plaintext is pushed to an in-memory FIFO queue BEFORE the API call.
 * On WS echo, it's popped from the queue. After API response, it's
 * persisted to IndexedDB for historical message access.
 *
 * Two-phase cache:
 * 1. preSendQueue: channelId → E2EEPayload[] (FIFO) — pushed before API call
 * 2. IndexedDB messageCache: messageId → content — persisted after API response
 *
 * No race condition: preSendQueue is set synchronously before the API call,
 * and WS echo only arrives after the server processes the message.
 */
const preSendQueue = new Map<string, E2EEPayload[]>();

/** In-memory cache for edit operations. messageId is known, so a direct Map suffices. */
const editCache = new Map<string, E2EEPayload>();

/** Push plaintext to FIFO queue before API call, so WS echo can find it. */
export function pushSentPlaintext(dmChannelId: string, payload: E2EEPayload): void {
  const queue = preSendQueue.get(dmChannelId);
  if (queue) {
    queue.push(payload);
  } else {
    preSendQueue.set(dmChannelId, [payload]);
  }
}

/** Pop own message plaintext from FIFO on WS echo. Order is preserved by server. */
export function popSentPlaintext(dmChannelId: string): E2EEPayload | null {
  const queue = preSendQueue.get(dmChannelId);
  if (!queue || queue.length === 0) return null;

  const payload = queue.shift()!;
  if (queue.length === 0) preSendQueue.delete(dmChannelId);
  return payload;
}

/** Remove last queued entry on send failure (LIFO — failed send's push is last). */
export function discardLastSentPlaintext(dmChannelId: string): void {
  const queue = preSendQueue.get(dmChannelId);
  if (!queue || queue.length === 0) return;

  queue.pop();
  if (queue.length === 0) preSendQueue.delete(dmChannelId);
}

/** Cache plaintext before edit API call. */
export function cacheEditPlaintext(messageId: string, payload: E2EEPayload): void {
  editCache.set(messageId, payload);
}

/** Pop plaintext from edit cache. */
export function popEditPlaintext(messageId: string): E2EEPayload | null {
  const payload = editCache.get(messageId) ?? null;
  if (payload) editCache.delete(messageId);
  return payload;
}

/** Persist plaintext to IndexedDB after API response for historical access. */
export async function persistSentPlaintext(
  messageId: string,
  dmChannelId: string,
  content: string
): Promise<void> {
  await keyStorage.cacheDecryptedMessage({
    messageId,
    channelId: "",
    dmChannelId,
    content,
    timestamp: Date.now(),
  });
}

// ──────────────────────────────────
// Encryption (Sender Side)
// ──────────────────────────────────

/**
 * Encrypt a DM message for all recipient devices + self-fanout.
 *
 * 1. Fetch recipient's prekey bundles
 * 2. Encrypt for each recipient device (X3DH + Double Ratchet)
 * 3. Encrypt for sender's other devices (self-fanout)
 * 4. Returns EncryptedEnvelope[] to be JSON-serialized as ciphertext
 */
export async function encryptDMMessage(
  currentUserId: string,
  recipientUserId: string,
  localDeviceId: string,
  plaintext: string
): Promise<EncryptedEnvelope[]> {
  const envelopes: EncryptedEnvelope[] = [];

  // Fetch all recipient device bundles
  const recipientBundles = await e2eeApi.fetchPreKeyBundles(recipientUserId);
  if (!recipientBundles.success || !recipientBundles.data) {
    throw new Error("Failed to fetch recipient prekey bundles");
  }

  // Recipient has no devices/keys — hasn't set up E2EE yet
  if (recipientBundles.data.length === 0) {
    throw new Error("RECIPIENT_NO_KEYS");
  }

  // Encrypt for each recipient device
  for (const bundle of recipientBundles.data) {
    const envelope = await encryptForDevice(
      recipientUserId,
      bundle,
      localDeviceId,
      plaintext
    );
    envelopes.push(envelope);
  }

  // Self-fanout: encrypt for sender's other devices.
  // Always force PreKey messages — after recovery restore, only key material
  // exists (no session state), so regular messages can't be decrypted.
  const selfBundles = await e2eeApi.fetchPreKeyBundles(currentUserId);
  if (selfBundles.success && selfBundles.data) {
    for (const bundle of selfBundles.data) {
      // Skip own device
      if (bundle.device_id === localDeviceId) continue;

      // Delete existing session to force PreKey message for recovery compatibility
      await keyStorage.deleteSession(currentUserId, bundle.device_id);

      const envelope = await encryptForDevice(
        currentUserId,
        bundle,
        localDeviceId,
        plaintext
      );
      envelopes.push(envelope);
    }
  }

  return envelopes;
}

/** Encrypt for a single device. Establishes X3DH session if none exists. */
async function encryptForDevice(
  userId: string,
  bundle: PreKeyBundleResponse,
  senderDeviceId: string,
  plaintext: string
): Promise<EncryptedEnvelope> {
  // Establish session if needed (X3DH key agreement)
  if (!(await signalProtocol.hasSessionFor(userId, bundle.device_id))) {
    await signalProtocol.processPreKeyBundle(userId, bundle.device_id, {
      identityKey: bundle.identity_key,
      // Fallback to identity_key for legacy devices without signing_key
      signingKey: bundle.signing_key ?? bundle.identity_key,
      signedPrekeyId: bundle.signed_prekey_id,
      signedPrekey: bundle.signed_prekey,
      signedPrekeySignature: bundle.signed_prekey_signature,
      oneTimePrekeyId: bundle.one_time_prekey_id ?? undefined,
      oneTimePrekey: bundle.one_time_prekey ?? undefined,
      registrationId: bundle.registration_id,
    });
  }

  // Encrypt with Double Ratchet
  const wireMessage = await signalProtocol.encryptMessage(
    userId,
    bundle.device_id,
    plaintext
  );

  return {
    sender_device_id: senderDeviceId,
    recipient_device_id: bundle.device_id,
    message_type: wireMessage.type,
    // Full SignalWireMessage stored as JSON (header + ciphertext + preKeyInfo)
    ciphertext: JSON.stringify(wireMessage),
  };
}

// ──────────────────────────────────
// Decryption (Receiver Side)
// ──────────────────────────────────

/**
 * Decrypt a received E2EE DM message.
 * Finds the envelope for this device, decrypts via Signal Protocol,
 * and parses the structured payload (content + file_keys).
 */
export async function decryptDMMessage(
  senderUserId: string,
  ciphertext: string,
  senderDeviceId: string
): Promise<E2EEPayload | null> {
  const localDeviceId = useE2EEStore.getState().localDeviceId;
  if (!localDeviceId) return null;

  // Parse envelope array
  let envelopes: EncryptedEnvelope[];
  try {
    envelopes = JSON.parse(ciphertext);
  } catch {
    console.error("[dmEncryption] Failed to parse ciphertext envelopes");
    return null;
  }

  // Find envelope for this device — try current ID first, then legacy IDs
  // (after recovery restore, old envelopes are encrypted to the old device ID)
  let myEnvelope = envelopes.find(
    (env) => env.recipient_device_id === localDeviceId
  );

  if (!myEnvelope) {
    // Check legacy device IDs (from before recovery restore)
    const legacyIds = await deviceManager.getLegacyDeviceIds();
    for (const legacyId of legacyIds) {
      myEnvelope = envelopes.find(
        (env) => env.recipient_device_id === legacyId
      );
      if (myEnvelope) break;
    }
  }

  if (!myEnvelope) {
    return null;
  }

  // Parse wire message
  let wireMessage: SignalWireMessage;
  try {
    wireMessage = JSON.parse(myEnvelope.ciphertext);
  } catch {
    console.error("[dmEncryption] Failed to parse wire message");
    return null;
  }

  // Decrypt via Signal Protocol
  try {
    const plaintext = await signalProtocol.decryptMessage(
      senderUserId,
      senderDeviceId,
      wireMessage
    );

    if (plaintext === null) return null;

    // Parse structured payload (content + file_keys)
    return decodePayload(plaintext);
  } catch (err) {
    console.error("[dmEncryption] decrypt failed:", err);
    throw err;
  }
}

/**
 * Batch-decrypt E2EE DM messages from fetchMessages/fetchOlderMessages.
 * Plaintext messages (encryption_version=0) pass through unchanged.
 * Successfully decrypted messages are cached to IndexedDB for client-side search.
 */
export async function decryptDMMessages(
  messages: DMMessage[]
): Promise<DMMessage[]> {
  const result: DMMessage[] = [];
  const toCache: import("./types").CachedDecryptedMessage[] = [];

  for (const msg of messages) {
    if (
      msg.encryption_version === 1 &&
      msg.ciphertext &&
      msg.sender_device_id
    ) {
      // Check IndexedDB cache first — re-decrypting breaks Double Ratchet state
      try {
        const cached = await keyStorage.getCachedDecryptedMessage(msg.id);
        if (cached) {
          result.push({ ...msg, content: cached.content });
          continue;
        }
      } catch {
        // Cache read error — fall through to decrypt
      }

      // Decrypt via Signal Protocol
      try {
        const payload = await decryptDMMessage(
          msg.user_id,
          msg.ciphertext,
          msg.sender_device_id
        );

        if (payload) {
          result.push({
            ...msg,
            content: payload.content,
            e2ee_file_keys: payload.file_keys,
          });

          if (payload.content) {
            toCache.push({
              messageId: msg.id,
              channelId: "",
              dmChannelId: msg.dm_channel_id,
              content: payload.content,
              timestamp: new Date(msg.created_at).getTime(),
            });
          }
        } else {
          // No envelope found for this device
          result.push({ ...msg, content: null });
        }
      } catch (err) {
        console.error(
          `[dmEncryption] Failed to decrypt msg ${msg.id}:`,
          err
        );
        useE2EEStore.getState().addDecryptionError({
          messageId: msg.id,
          channelId: msg.dm_channel_id,
          error: err instanceof Error ? err.message : "Decryption failed",
          timestamp: Date.now(),
        });
        result.push({ ...msg, content: null });
      }
    } else {
      // Plaintext message — pass through
      result.push(msg);
    }
  }

  // Batch cache write for performance
  if (toCache.length > 0) {
    keyStorage.cacheDecryptedMessages(toCache).catch((err) => {
      console.error("[dmEncryption] Failed to cache messages:", err);
    });
  }

  return result;
}
