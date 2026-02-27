/**
 * fileValidation — Dosya yükleme validasyonu.
 *
 * Hem file input, hem drag-drop, hem clipboard paste tarafından kullanılır.
 * Validasyon kuralları:
 * - MAX_FILE_SIZE (25MB) üstü dosyalar reddedilir
 * - ALLOWED_MIME_TYPES dışındaki dosyalar reddedilir
 */

import { MAX_FILE_SIZE, ALLOWED_MIME_TYPES } from "./constants";

/**
 * validateFiles — FileList veya File[] içinden geçerli dosyaları filtreler.
 *
 * @param files - Browser'dan gelen dosya listesi (file input, drag-drop, clipboard)
 * @returns Validasyonu geçen File dizisi
 */
export function validateFiles(files: FileList | File[]): File[] {
  const valid: File[] = [];
  for (const file of Array.from(files)) {
    if (file.size > MAX_FILE_SIZE) continue;
    if (!ALLOWED_MIME_TYPES.includes(file.type as typeof ALLOWED_MIME_TYPES[number])) continue;
    valid.push(file);
  }
  return valid;
}
