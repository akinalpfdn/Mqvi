import { useCallback } from "react";
import { useFileDrop } from "./useFileDrop";

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
  const addFiles = useCallback(
    (incoming: File[]) => {
      const images = incoming.filter((f) => ALLOWED_IMAGE_TYPES.includes(f.type));
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
    [setFiles, max, onLimit]
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
