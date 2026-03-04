/**
 * E2EE Payload — Sifreli mesaj payload encode/decode.
 *
 * E2EE mesajlarda plaintext sadece bir string degildir — dosya anahtarlari
 * da tasinir. Bu modul plaintext'i structured JSON olarak encode/decode eder.
 *
 * Payload formati:
 * {
 *   "content": "mesaj metni",
 *   "file_keys": [{ key, iv, filename, mimeType, originalSize, digest }]
 * }
 *
 * Backward-compatible: Eger plaintext JSON parse edilemezse veya
 * "content" alani yoksa, plaintext dogrudan mesaj metni olarak kabul edilir.
 * Bu, dosya icermeyen eski E2EE mesajlarin (plain string) calismaya
 * devam etmesini saglar.
 */

import type { EncryptedFileMeta } from "./fileEncryption.js";

// ──────────────────────────────────
// Types
// ──────────────────────────────────

/**
 * E2EE plaintext payload yapisi.
 * Sifrelenmeden once mesaj + dosya anahtarlari birlikte JSON'a cevirilir.
 */
export type E2EEPayload = {
  /** Mesaj metni */
  content: string;
  /** Dosya sifreleme anahtarlari (her dosya icin bir adet, index sirasina gore eslenir) */
  file_keys?: EncryptedFileMeta[];
};

// ──────────────────────────────────
// Encode / Decode
// ──────────────────────────────────

/**
 * Plaintext payload olusturur (sifreleme oncesi).
 *
 * Dosya yoksa bile JSON formatinda encode eder — tutarlilik icin.
 *
 * @param content - Mesaj metni
 * @param fileKeys - Dosya sifreleme anahtarlari (opsiyonel)
 * @returns JSON string (sifrelemeye hazir)
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
 * Decrypt edilmis plaintext'i parse eder.
 *
 * Backward-compatible:
 * - JSON parse basarili ve "content" alani varsa → structured payload
 * - JSON parse basarisiz veya "content" yoksa → plain string (eski format)
 *
 * @param plaintext - Decrypt edilmis metin
 * @returns Content + opsiyonel file_keys
 */
export function decodePayload(plaintext: string): E2EEPayload {
  try {
    const parsed = JSON.parse(plaintext);
    // Structured payload mi kontrol et
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
    // JSON parse basarisiz — plain string
  }

  // Eski format: plaintext dogrudan mesaj metni
  return { content: plaintext };
}
