/**
 * Channel Encryption — E2EE encrypt/decrypt layer for channel/group messages.
 *
 * This module is called by messageStore (sending) and useWebSocket (receiving).
 * Using Sender Key Protocol primitives:
 * - Send: plaintext → SenderKeyMessage (single ciphertext, all members share)
 * - Receive: SenderKeyMessage → plaintext
 *
 * Sender Key vs Signal (DM):
 * - In DM, separate encryption is performed for each recipient device (N ciphertexts)
 * - In a channel, a single encryption is performed and all members decrypt the same ciphertext
 * - Performance benefit: in a 100-member channel, 1 encrypt vs 100 encrypts
 *
 * Sender Key distribution:
 * The sender creates a new Sender Key on the first message (or on key rotation)
 * and uploads the distribution message to the server. Members fetch the sender
 * key from the server and store it as inbound.
 *
 * Key rotation:
 * - Automatic rotation every 100 messages
 * - Automatic rotation every 7 days
 * - Rotation when a member is removed (future)
 */

import * as senderKeyProtocol from "./senderKeyProtocol.js";
import * as e2eeApi from "../api/e2ee.js";
import * as keyStorage from "./keyStorage.js";
import { fromBase64 } from "./signalProtocol.js";
import { decodePayload, type E2EEPayload } from "./e2eePayload.js";
import { useE2EEStore } from "../stores/e2eeStore.js";
import { useServerStore } from "../stores/serverStore.js";
import type { SenderKeyMessage, SenderKeyDistributionData } from "./types.js";
import type { Message } from "../types/index.js";

// ──────────────────────────────────
// Encryption (Sender Side)
// ──────────────────────────────────

/**
 * Encrypts a channel message with the Sender Key.
 *
 * Flow:
 * 1. Check whether an outbound sender key exists for this channel
 * 2. If missing or rotation is needed → create a new distribution + upload to server
 * 3. Encrypt with encryptGroupMessage
 * 4. Returns a SenderKeyMessage — JSON.stringify is written into the ciphertext field
 *
 * @param channelId - Channel ID
 * @param userId - Sender user ID
 * @param deviceId - This device's ID
 * @param plaintext - Unencrypted message text
 */
export async function encryptChannelMessage(
  channelId: string,
  userId: string,
  deviceId: string,
  plaintext: string
): Promise<SenderKeyMessage> {
  // Check whether rotation is needed
  const needsRotation = await senderKeyProtocol.needsSenderKeyRotation(
    channelId,
    userId,
    deviceId
  );

  if (needsRotation) {
    // Create a new Sender Key and upload it to the server
    await createAndUploadDistribution(channelId, userId, deviceId);
  }

  // Encrypt with Sender Key — single ciphertext, all members decrypt
  return senderKeyProtocol.encryptGroupMessage(
    channelId,
    userId,
    deviceId,
    plaintext
  );
}

/**
 * Creates a new Sender Key distribution and uploads it to the server.
 *
 * The server stores the distribution and dispatches it to channel members.
 * Members retrieve this distribution via fetchAndProcessDistributions.
 */
async function createAndUploadDistribution(
  channelId: string,
  userId: string,
  deviceId: string
): Promise<void> {
  const distribution = await senderKeyProtocol.createDistribution(
    channelId,
    userId,
    deviceId
  );

  const serverId = useServerStore.getState().activeServerId;
  if (!serverId) throw new Error("No active server");

  await e2eeApi.uploadGroupSession(serverId, channelId, deviceId, {
    session_id: distribution.distributionId,
    session_data: JSON.stringify(distribution),
  });
}

// ──────────────────────────────────
// Decryption (Receiver Side)
// ──────────────────────────────────

/**
 * Decrypts an incoming E2EE channel message and parses the structured payload.
 *
 * The ciphertext field contains a JSON-serialized SenderKeyMessage.
 * It is decrypted with the sender's sender key.
 * After decryption, decodePayload separates content + file_keys.
 *
 * @param senderUserId - Sender user ID
 * @param channelId - Channel ID
 * @param ciphertext - JSON string SenderKeyMessage
 * @param senderDeviceId - Sender device ID
 * @returns Decrypted payload (content + file_keys) or null
 */
export async function decryptChannelMessage(
  senderUserId: string,
  channelId: string,
  ciphertext: string,
  senderDeviceId: string
): Promise<E2EEPayload | null> {
  // Parse the Sender Key message
  let senderKeyMsg: SenderKeyMessage;
  try {
    senderKeyMsg = JSON.parse(ciphertext);
  } catch {
    console.error("[channelEncryption] Failed to parse SenderKeyMessage");
    return null;
  }

  // If we don't have the sender's sender key, fetch it from the server
  try {
    await ensureSenderKeyForDecryption(
      channelId,
      senderUserId,
      senderDeviceId,
      senderKeyMsg.distributionId
    );
  } catch (err) {
    console.error(
      `[channelEncryption] Failed to fetch sender key for ${senderUserId}:${senderDeviceId}:`,
      err
    );
    return null;
  }

  // Decrypt with Sender Key
  const plaintext = await senderKeyProtocol.decryptGroupMessage(
    channelId,
    senderUserId,
    senderDeviceId,
    senderKeyMsg
  );

  if (plaintext === null) return null;

  // Parse structured payload — separate content + file_keys
  return decodePayload(plaintext);
}

/**
 * Ensures the sender's sender key is available.
 * If missing, fetches the distribution from the server and processes it.
 *
 * Also performs initialChainKey migration: For old-format sender keys
 * (no initialChainKey), the original chainKey is taken from the distribution
 * and set as initialChainKey. This allows out-of-order messages
 * (older iterations arriving via fetchMessages) to be decrypted.
 */
async function ensureSenderKeyForDecryption(
  channelId: string,
  senderUserId: string,
  senderDeviceId: string,
  distributionId: string
): Promise<void> {
  // Check whether a sender key exists and matches the correct distribution
  const existingKey = await keyStorage.getSenderKey(
    channelId,
    senderUserId,
    senderDeviceId
  );

  const needsKey = !existingKey || senderKeyProtocol.needsRotationCheck(existingKey);

  // Migration is needed if initialChainKey is missing — will be taken from the distribution
  const needsInitialKeyMigration =
    existingKey &&
    !existingKey.initialChainKey &&
    existingKey.distributionId === distributionId;

  if (!needsKey && !needsInitialKeyMigration) return;

  // Fetch distributions from the server
  const serverId = useServerStore.getState().activeServerId;
  if (!serverId) return;

  const res = await e2eeApi.fetchGroupSessions(serverId, channelId);
  if (!res.success || !res.data) return;

  // Find this sender's distribution and process it
  for (const session of res.data) {
    if (
      session.sender_user_id === senderUserId &&
      session.sender_device_id === senderDeviceId
    ) {
      try {
        const distribution: SenderKeyDistributionData = JSON.parse(
          session.session_data
        );

        if (distribution.distributionId === distributionId) {
          if (needsInitialKeyMigration && existingKey) {
            // Migration: Add initialChainKey to existing key (preserve iteration/chainKey)
            existingKey.initialChainKey = fromBase64(distribution.chainKey);
            await keyStorage.saveSenderKey(existingKey);
          } else if (needsKey) {
            await senderKeyProtocol.processDistribution(
              channelId,
              senderUserId,
              senderDeviceId,
              distribution
            );
          }
          return;
        }
      } catch {
        console.error(
          "[channelEncryption] Failed to parse distribution data"
        );
      }
    }
  }
}

/**
 * Bulk-decrypts E2EE messages in a Message array.
 *
 * Called after fetchMessages/fetchOlderMessages.
 * Plaintext messages (encryption_version=0) are left untouched.
 * Messages that fail to decrypt are marked with content=null.
 *
 * After successful decryption:
 * - content + e2ee_file_keys are set on the message
 * - The message is written to the IndexedDB cache (for client-side search)
 *
 * @param messages - Raw message array from the backend
 * @returns Decrypted message array (same order)
 */
export async function decryptChannelMessages(
  messages: Message[]
): Promise<Message[]> {
  // Skip decryption if E2EE init is not complete (keys not yet generated).
  const e2eeStatus = useE2EEStore.getState().initStatus;
  if (e2eeStatus !== "ready") {
    return messages.map((msg) =>
      msg.encryption_version === 1 ? { ...msg, content: null } : msg
    );
  }

  const result: Message[] = [];
  const toCache: import("./types").CachedDecryptedMessage[] = [];

  for (const msg of messages) {
    if (
      msg.encryption_version === 1 &&
      msg.ciphertext &&
      msg.sender_device_id
    ) {
      try {
        const payload = await decryptChannelMessage(
          msg.user_id,
          msg.channel_id,
          msg.ciphertext,
          msg.sender_device_id
        );

        result.push({
          ...msg,
          content: payload?.content ?? null,
          e2ee_file_keys: payload?.file_keys,
        });

        // Successful decrypt → write to IndexedDB cache (for search)
        if (payload?.content) {
          toCache.push({
            messageId: msg.id,
            channelId: msg.channel_id,
            dmChannelId: null,
            content: payload.content,
            timestamp: new Date(msg.created_at).getTime(),
          });
        }
      } catch (err) {
        console.error(
          `[channelEncryption] Failed to decrypt msg ${msg.id}:`,
          err
        );
        // Decrypt failed — record as a decryption error
        useE2EEStore.getState().addDecryptionError({
          messageId: msg.id,
          channelId: msg.channel_id,
          error: err instanceof Error ? err.message : "Decryption failed",
          timestamp: Date.now(),
        });
        result.push({ ...msg, content: null });
      }
    } else {
      // Plaintext message — leave as-is
      result.push(msg);
    }
  }

  // Bulk cache write — performant via a single transaction
  if (toCache.length > 0) {
    keyStorage.cacheDecryptedMessages(toCache).catch((err) => {
      console.error("[channelEncryption] Failed to cache messages:", err);
    });
  }

  return result;
}
