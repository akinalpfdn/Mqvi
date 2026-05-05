/**
 * fileValidation — File upload validation.
 *
 * Used by file input, drag-drop, and clipboard paste.
 * Rejects files exceeding MAX_FILE_SIZE. All MIME types are accepted —
 * XSS prevention is handled server-side at serve time (safe-serve whitelist).
 */

import { MAX_FILE_SIZE } from "./constants";

/** Filters valid files from a FileList or File array. */
export function validateFiles(files: FileList | File[]): File[] {
  const valid: File[] = [];
  for (const file of Array.from(files)) {
    if (file.size > MAX_FILE_SIZE) continue;
    valid.push(file);
  }
  return valid;
}
