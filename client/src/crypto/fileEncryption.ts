/**
 * File Encryption — E2EE file encrypt/decrypt.
 *
 * Each file gets a random AES-256-GCM key. Encrypted file is uploaded
 * to server, key is included in the E2EE message payload (server never sees it).
 *
 * Image thumbnails are encrypted with the same key but different IV,
 * allowing preview without downloading the full file.
 */

import { toBase64 } from "./signalProtocol";
import { createAttachmentPreview } from "../utils/imageEncoding";

// ──────────────────────────────────
// Types
// ──────────────────────────────────

/** Encrypted file metadata, included in the E2EE message payload. */
export type EncryptedFileMeta = {
  /** AES-256-GCM key (base64, 32 bytes) */
  key: string;
  /** Initialization vector (base64, 12 bytes) */
  iv: string;
  /** Original filename */
  filename: string;
  /** Original MIME type */
  mimeType: string;
  /** Original file size (bytes) */
  originalSize: number;
  /** SHA-256 hash of original file (hex) — integrity check */
  digest: string;
  /**
   * IV for the companion thumbnail, when one was sent. The thumbnail reuses the file's key with a
   * distinct IV — safe for AES-GCM, which only forbids reusing a (key, IV) pair — so the payload
   * grows by one field instead of a whole second key.
   *
   * Absent on messages predating thumbnails and on attachments that have none. Lives inside the
   * encrypted payload, so the server never sees it; the thumbnail's URL and pixel size are the
   * only parts stored in the clear.
   */
  thumbIv?: string;
};

export type EncryptedFileResult = {
  /** Encrypted file blob (for server upload) */
  encryptedBlob: Blob;
  /** File metadata (for message payload) */
  meta: EncryptedFileMeta;
};

export type EncryptedThumbnailResult = {
  /** Encrypted thumbnail blob */
  encryptedBlob: Blob;
  /** Thumbnail IV (base64) — same key as the file */
  iv: string;
  /** Thumbnail dimensions */
  width: number;
  height: number;
};

// ──────────────────────────────────
// File Encryption
// ──────────────────────────────────

/** Encrypt a file with AES-256-GCM. Generates random key + IV, computes SHA-256 hash. */
export async function encryptFile(file: File): Promise<EncryptedFileResult> {
  // Random AES-256 key and 12-byte IV
  const fileKey = crypto.getRandomValues(new Uint8Array(32));
  const fileIV = crypto.getRandomValues(new Uint8Array(12));

  // Read file contents
  const plaintext = new Uint8Array(await file.arrayBuffer());

  // SHA-256 hash for integrity check
  const hashBuffer = await crypto.subtle.digest("SHA-256", plaintext as BufferSource);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Encrypt with AES-256-GCM
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    fileKey as BufferSource,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: fileIV },
    cryptoKey,
    plaintext as BufferSource
  );

  return {
    encryptedBlob: new Blob([encrypted], {
      type: "application/octet-stream",
    }),
    meta: {
      key: toBase64(fileKey),
      iv: toBase64(fileIV),
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      originalSize: file.size,
      digest: hashHex,
    },
  };
}


/**
 * Drains a response body while reporting bytes read.
 *
 * arrayBuffer() gives no visibility into a download that can take a minute on a slow link, which
 * is why a large attachment looked frozen. Falls back to arrayBuffer() when the body cannot be
 * streamed, so the caller still gets its data.
 */
async function readWithProgress(
  response: Response,
  onProgress: (loaded: number, total: number | null) => void
): Promise<ArrayBuffer> {
  const header = response.headers.get("Content-Length");
  const total = header ? Number(header) : null;
  if (!response.body) return response.arrayBuffer();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, Number.isFinite(total) ? total : null);
  }

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.buffer;
}

/** Download and decrypt an encrypted file. Verifies SHA-256 integrity. */
export async function decryptFile(
  url: string,
  meta: EncryptedFileMeta,
  options?: {
    /** `total` is null when the response carries no Content-Length. */
    onProgress?: (loaded: number, total: number | null) => void;
    signal?: AbortSignal;
  }
): Promise<File> {
  // Download encrypted file
  const response = await fetch(url, { signal: options?.signal });
  if (!response.ok) {
    throw new Error(`Failed to download encrypted file: HTTP ${response.status}`);
  }

  const encryptedData = options?.onProgress
    ? await readWithProgress(response, options.onProgress)
    : await response.arrayBuffer();

  // Decrypt with AES-256-GCM
  const fileKey = fromBase64(meta.key);
  const fileIV = fromBase64(meta.iv);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    fileKey as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fileIV as BufferSource },
    cryptoKey,
    encryptedData
  );

  // SHA-256 integrity check
  const hashBuffer = await crypto.subtle.digest("SHA-256", decrypted);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (hashHex !== meta.digest) {
    throw new Error(
      `File integrity check failed: expected ${meta.digest}, got ${hashHex}`
    );
  }

  // Create File object
  return new File([decrypted], meta.filename, {
    type: meta.mimeType,
  });
}

// ──────────────────────────────────
// Thumbnail Generation & Encryption
// ──────────────────────────────────

/** Generate an encrypted thumbnail for image files. Uses same key with different IV. */
export async function encryptThumbnail(
  file: File,
  fileKey: string
): Promise<EncryptedThumbnailResult | null> {
  // The image work is shared with the plaintext path rather than duplicated. The copy that used to
  // live here decoded without imageOrientation (phone photos came out rotated), encoded JPEG (a
  // transparent PNG got a black background) and capped at 256px, which is soft in a slot that
  // renders up to 300px tall at 2x.
  const thumbnail = await createAttachmentPreview(file);
  if (!thumbnail) return null;

  try {
    const { width, height } = thumbnail;
    const thumbnailData = new Uint8Array(await thumbnail.blob.arrayBuffer());

    // Encrypt with different IV (same key)
    const thumbnailIV = crypto.getRandomValues(new Uint8Array(12));
    const key = fromBase64(fileKey);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key as BufferSource,
      "AES-GCM",
      false,
      ["encrypt"]
    );

    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: thumbnailIV },
      cryptoKey,
      thumbnailData as BufferSource
    );

    return {
      encryptedBlob: new Blob([encrypted], {
        type: "application/octet-stream",
      }),
      iv: toBase64(thumbnailIV),
      width,
      height,
    };
  } catch {
    // Thumbnail generation failure is non-critical
    return null;
  }
}

/** Decrypt an encrypted thumbnail. Returns an Object URL. */
export async function decryptThumbnail(
  url: string,
  fileKey: string,
  thumbnailIV: string
): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download thumbnail: HTTP ${response.status}`);
  }

  const encryptedData = await response.arrayBuffer();
  const key = fromBase64(fileKey);
  const iv = fromBase64(thumbnailIV);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    "AES-GCM",
    false,
    ["decrypt"]
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    cryptoKey,
    encryptedData
  );

  // Deliberately untyped: the encoder picks WebP, PNG or JPEG per platform, and the sender's choice
  // is not carried in the metadata. Asserting "image/jpeg" on a WebP would be a lie the browser has
  // to work around; with no type it sniffs the bytes, which it does reliably for images.
  const blob = new Blob([decrypted]);
  return URL.createObjectURL(blob);
}

// ──────────────────────────────────
// Internal Helpers
// ──────────────────────────────────

/** base64 → Uint8Array. Local copy to avoid circular dependency with signalProtocol. */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
