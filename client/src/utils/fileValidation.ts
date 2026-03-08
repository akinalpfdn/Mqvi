/**
 * fileValidation — File upload validation.
 *
 * Used by file input, drag-drop, and clipboard paste.
 * Rejects files exceeding MAX_FILE_SIZE or outside ALLOWED_MIME_TYPES.
 */

import { MAX_FILE_SIZE, ALLOWED_MIME_TYPES } from "./constants";

/** Filters valid files from a FileList or File array. */
export function validateFiles(files: FileList | File[]): File[] {
  const valid: File[] = [];
  for (const file of Array.from(files)) {
    if (file.size > MAX_FILE_SIZE) continue;
    if (!ALLOWED_MIME_TYPES.includes(file.type as typeof ALLOWED_MIME_TYPES[number])) continue;
    valid.push(file);
  }
  return valid;
}
