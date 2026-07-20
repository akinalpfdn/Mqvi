import { useCallback } from "react";
import { useFileDrop } from "./useFileDrop";
import { useFileRejectionNotice } from "./useFileRejectionNotice";
import { validateFiles, partitionFiles } from "../utils/fileValidation";
import { MAX_FILE_SIZE } from "../utils/constants";

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/**
 * useImageAttach — shared image-attachment behavior for composers: click-to-pick, clipboard paste,
 * and drag-and-drop, filtered to images and capped at `max`. `onLimit` fires when the cap is hit.
 */
const isImageMime = (mime: string) => ALLOWED_IMAGE_TYPES.includes(mime);

/**
 * `isAllowed` overrides the image-only filter — feedback also takes video. The hook keeps its name
 * because images remain the default and its other callers are unchanged.
 */
export function useImageAttach(
  setFiles: React.Dispatch<React.SetStateAction<File[]>>,
  max: number,
  onLimit?: () => void,
  // Module-level default: an inline arrow would be a new identity every render, rebuilding addFiles
  // and every hook that depends on it.
  isAllowed: (mime: string) => boolean = isImageMime
) {
  const notifyRejected = useFileRejectionNotice();

  const addFiles = useCallback(
    (incoming: File[]) => {
      // Both refusals are reported. A file dropped here used to vanish with no explanation whether
      // it was the wrong type or too big.
      const byType = partitionFiles(incoming, (f) => isAllowed(f.type));
      notifyRejected(byType.rejected, { reason: "type" });
      const { accepted: images, rejected } = validateFiles(byType.accepted, MAX_FILE_SIZE);
      notifyRejected(rejected, { reason: "size", maxBytes: MAX_FILE_SIZE });
      if (images.length === 0) return;
      setFiles((prev) => {
        const remaining = max - prev.length;
        if (remaining <= 0) {
          onLimit?.();
          return prev;
        }
        if (images.length > remaining) onLimit?.();
        return [...prev, ...images.slice(0, remaining)];
      });
    },
    [setFiles, max, onLimit, notifyRejected, isAllowed]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const pasted: File[] = [];
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) pasted.push(f);
        }
      }
      if (pasted.length > 0) addFiles(pasted);
    },
    [addFiles]
  );

  const { isDragging, dragHandlers } = useFileDrop(addFiles);

  return { addFiles, handlePaste, isDragging, dragHandlers };
}
