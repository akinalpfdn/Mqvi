/**
 * E2EE Payload — encode/decode for encrypted message payloads.
 *
 * In E2EE messages, the plaintext is not just a string — file keys
 * are also carried. This module encodes/decodes the plaintext as
 * structured JSON.
 *
 * Payload format:
 * {
 *   "content": "message text",
 *   "file_keys": [{ key, iv, filename, mimeType, originalSize, digest }]
 * }
 *
 * Backward-compatible: If the plaintext cannot be JSON parsed or has
 * no "content" field, the plaintext is treated directly as the message
 * text. This ensures older E2EE messages without files (plain string)
 * continue to work.
 */

import type { EncryptedFileMeta } from "./fileEncryption.js";

// ──────────────────────────────────
// Types
// ──────────────────────────────────

/**
 * E2EE plaintext payload structure.
 * Before encryption, message + file keys are combined into JSON.
 */
export type E2EEPayload = {
  /** Message text */
  content: string;
  /** File encryption keys (one per file, matched by index order) */
  file_keys?: EncryptedFileMeta[];
};

// ──────────────────────────────────
// Encode / Decode
// ──────────────────────────────────

/**
 * Builds the plaintext payload (before encryption).
 *
 * Encodes as JSON even when there are no files — for consistency.
 *
 * @param content - Message text
 * @param fileKeys - File encryption keys (optional)
 * @returns JSON string (ready for encryption)
 */
export function encodePayload(
  content: string,
  fileKeys?: EncryptedFileMeta[]
): string {
  const payload: E2EEPayload = { content };
  if (fileKeys && fileKeys.length > 0) {
    payload.file_keys = fileKeys;
  }
  return JSON.stringify(payload);
}

/**
 * Parses the decrypted plaintext.
 *
 * Backward-compatible:
 * - JSON parse succeeds and "content" field exists → structured payload
 * - JSON parse fails or no "content" → plain string (old format)
 *
 * @param plaintext - Decrypted text
 * @returns Content + optional file_keys
 */
export function decodePayload(plaintext: string): E2EEPayload {
  try {
    const parsed = JSON.parse(plaintext);
    // Check whether this is a structured payload
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.content === "string"
    ) {
      return {
        content: parsed.content,
        file_keys: Array.isArray(parsed.file_keys)
          ? parsed.file_keys
          : undefined,
      };
    }
  } catch {
    // JSON parse failed — plain string
  }

  // Old format: plaintext is the message text directly
  return { content: plaintext };
}
