/**
 * File Encryption — E2EE dosya sifreleme/cozme.
 *
 * Her dosya icin rastgele AES-256-GCM anahtari uretilir.
 * Sifreli dosya sunucuya yuklenir, anahtar mesajin sifreli
 * payload'ina dahil edilir (sunucu anahtari bilmez).
 *
 * Akis:
 * 1. Client: encryptFile(file) → { encryptedBlob, fileKey, fileIV, sha256 }
 * 2. Client: encryptedBlob'u sunucuya yukle
 * 3. Client: fileKey + fileIV + sha256'yi mesaj payload'ina ekle
 * 4. Client: Mesaji E2EE ile sifrele (fileKey dahil)
 * 5. Alici: Mesaji E2EE ile coz → fileKey elde et
 * 6. Alici: Sunucudan sifreli dosyayi indir
 * 7. Alici: decryptFile(blob, fileKey, fileIV, sha256) → orijinal dosya
 *
 * Thumbnail:
 * Resim dosyalari icin client Canvas API ile kucuk on izleme olusturur.
 * Thumbnail ayni key ile ama farkli IV ile sifrelenir.
 * Bu sayede chat'te on izleme gosterilebilir (tam dosyayi indirmeden).
 */

import { toBase64 } from "./signalProtocol";

// ──────────────────────────────────
// Types
// ──────────────────────────────────

/**
 * Sifreli dosya meta verileri.
 * Mesajin sifreli payload'ina dahil edilir.
 */
export type EncryptedFileMeta = {
  /** AES-256-GCM anahtari (base64, 32 bytes) */
  key: string;
  /** Initialization vector (base64, 12 bytes) */
  iv: string;
  /** Orijinal dosya adi */
  filename: string;
  /** Orijinal MIME tipi */
  mimeType: string;
  /** Orijinal dosya boyutu (byte) */
  originalSize: number;
  /** SHA-256 hash of original file (hex) — integrity check */
  digest: string;
};

/**
 * encryptFile sonucu.
 */
export type EncryptedFileResult = {
  /** Sifreli dosya blob'u (sunucuya yuklenecek) */
  encryptedBlob: Blob;
  /** Dosya meta verileri (mesaj payload'ina eklenecek) */
  meta: EncryptedFileMeta;
};

/**
 * Thumbnail sonucu.
 */
export type EncryptedThumbnailResult = {
  /** Sifreli thumbnail blob'u */
  encryptedBlob: Blob;
  /** Thumbnail IV (base64) — key dosyaninki ile ayni */
  iv: string;
  /** Thumbnail boyutlari */
  width: number;
  height: number;
};

// ──────────────────────────────────
// File Encryption
// ──────────────────────────────────

/**
 * Dosyayi AES-256-GCM ile sifreler.
 *
 * Rastgele key + IV uretir, SHA-256 hash hesaplar,
 * dosyayi sifreler ve meta bilgileri doner.
 *
 * @param file - Sifrelenmemis dosya
 * @returns Sifreli blob + meta bilgiler
 */
export async function encryptFile(file: File): Promise<EncryptedFileResult> {
  // Rastgele AES-256 key ve 12-byte IV
  const fileKey = crypto.getRandomValues(new Uint8Array(32));
  const fileIV = crypto.getRandomValues(new Uint8Array(12));

  // Dosya icerigini oku
  const plaintext = new Uint8Array(await file.arrayBuffer());

  // SHA-256 hash hesapla (integrity check icin)
  const hashBuffer = await crypto.subtle.digest("SHA-256", plaintext as BufferSource);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // AES-256-GCM ile sifrele
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
 * Sifreli dosyayi indirir ve cozer.
 *
 * Sunucudan sifreli blob'u ceker, AES-256-GCM ile cozer,
 * SHA-256 hash ile integrity kontrol eder.
 *
 * @param url - Sifreli dosyanin URL'si (sunucu)
 * @param meta - Dosya meta verileri (mesaj payload'indan)
 * @returns Cozulmus File nesnesi
 */
export async function decryptFile(
  url: string,
  meta: EncryptedFileMeta
): Promise<File> {
  // Sifreli dosyayi indir
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download encrypted file: HTTP ${response.status}`);
  }

  const encryptedData = await response.arrayBuffer();

  // AES-256-GCM ile coz
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

  // File nesnesini olustur
  return new File([decrypted], meta.filename, {
    type: meta.mimeType,
  });
}

// ──────────────────────────────────
// Thumbnail Generation & Encryption
// ──────────────────────────────────

/** Thumbnail maksimum boyutu (piksel) */
const THUMBNAIL_MAX_SIZE = 256;

/**
 * Resim dosyasi icin sifreli thumbnail uretir.
 *
 * Canvas API ile orijinal resmi kucultup JPEG'e cevirir,
 * ayni dosya anahtari ile (farkli IV) sifreler.
 *
 * @param file - Orijinal resim dosyasi
 * @param fileKey - Dosyanin AES key'i (base64)
 * @returns Sifreli thumbnail blob + IV + boyutlar
 */
export async function encryptThumbnail(
  file: File,
  fileKey: string
): Promise<EncryptedThumbnailResult | null> {
  // Sadece resim dosyalari icin thumbnail olustur
  if (!file.type.startsWith("image/")) {
    return null;
  }

  try {
    // Resmi yukle
    const imageBitmap = await createImageBitmap(file);
    const { width, height } = calculateThumbnailSize(
      imageBitmap.width,
      imageBitmap.height
    );

    // Canvas'a ciz
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.drawImage(imageBitmap, 0, 0, width, height);
    imageBitmap.close();

    // JPEG blob'a cevir (quality: 0.7)
    const thumbnailBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.7,
    });

    const thumbnailData = new Uint8Array(await thumbnailBlob.arrayBuffer());

    // Farkli IV ile sifrele (ayni key)
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
    // Thumbnail olusturulamazsa null don — kritik degil
    return null;
  }
}

/**
 * Sifreli thumbnail'i cozer.
 *
 * @param url - Sifreli thumbnail URL'si
 * @param fileKey - Dosya anahtari (base64)
 * @param thumbnailIV - Thumbnail IV (base64)
 * @returns Cozulmus thumbnail blob URL (Object URL)
 */
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

  const blob = new Blob([decrypted], { type: "image/jpeg" });
  return URL.createObjectURL(blob);
}

// ──────────────────────────────────
// Internal Helpers
// ──────────────────────────────────

/**
 * Thumbnail boyutlarini hesaplar.
 * En buyuk kenar THUMBNAIL_MAX_SIZE'a sıgacak sekilde olcekler.
 */
function calculateThumbnailSize(
  originalWidth: number,
  originalHeight: number
): { width: number; height: number } {
  if (
    originalWidth <= THUMBNAIL_MAX_SIZE &&
    originalHeight <= THUMBNAIL_MAX_SIZE
  ) {
    return { width: originalWidth, height: originalHeight };
  }

  const ratio = Math.min(
    THUMBNAIL_MAX_SIZE / originalWidth,
    THUMBNAIL_MAX_SIZE / originalHeight
  );

  return {
    width: Math.round(originalWidth * ratio),
    height: Math.round(originalHeight * ratio),
  };
}

/**
 * base64 → Uint8Array (fileEncryption icin lokal kopyasi).
 * signalProtocol'den import etmek yerine lokal tanimlandi
 * circular dependency riski olmamasi icin.
 */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
