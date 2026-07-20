/**
 * fileValidation — File upload validation.
 *
 * Used by file input, drag-drop, and clipboard paste.
 * All MIME types are accepted — XSS prevention is handled server-side at serve time
 * (safe-serve whitelist).
 *
 * Returns the rejected files rather than dropping them: a file that silently disappears is how a
 * 180MB video looked like it was uploading for five minutes with nothing to show for it.
 */

import { MAX_FILE_SIZE } from "./constants";

type FileValidationResult = {
  accepted: File[];
  /** Over the limit — the caller is responsible for telling the user. */
  rejected: File[];
};

export function validateFiles(
  files: FileList | File[],
  maxBytes: number = MAX_FILE_SIZE
): FileValidationResult {
  const accepted: File[] = [];
  const rejected: File[] = [];

  for (const file of Array.from(files)) {
    if (file.size > maxBytes) {
      rejected.push(file);
    } else {
      accepted.push(file);
    }
  }

  return { accepted, rejected };
}

export type { FileValidationResult };
