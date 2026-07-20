import { useCallback } from "react";
import { useFileDrop } from "./useFileDrop";
import { useFileRejectionNotice } from "./useFileRejectionNotice";
import { validateFiles } from "../utils/fileValidation";
import { MAX_FILE_SIZE } from "../utils/constants";

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/**
 * useImageAttach — shared image-attachment behavior for composers: click-to-pick, clipboard paste,
 * and drag-and-drop, filtered to images and capped at `max`. `onLimit` fires when the cap is hit.
 */
export function useImageAttach(
  setFiles: React.Dispatch<React.SetStateAction<File[]>>,
  max: number,
  onLimit?: () => void
) {
  const notifyRejected = useFileRejectionNotice();

  const addFiles = useCallback(
    (incoming: File[]) => {
      const typed = incoming.filter((f) => ALLOWED_IMAGE_TYPES.includes(f.type));
      // Size was never checked here, so an oversized image was queued and only died at the server.
      const { accepted: images, rejected } = validateFiles(typed, MAX_FILE_SIZE);
      notifyRejected(rejected, MAX_FILE_SIZE);
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
    [setFiles, max, onLimit, notifyRejected]
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
