/**
 * useFileDrop — Drag-and-drop file upload hook.
 *
 * enterCount pattern: nested child elements fire spurious dragLeave events.
 * Counter increments on enter, decrements on leave — only truly "left" at 0.
 *
 * No conflict with tab drag-drop: tab drags have empty dataTransfer.files.
 */

import { useState, useCallback, useRef } from "react";
import { validateFiles } from "../utils/fileValidation";
import { useFileRejectionNotice } from "./useFileRejectionNotice";
import { MAX_FILE_SIZE } from "../utils/constants";

type FileDropHandlers = {
  onDragEnter: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
};

type UseFileDropReturn = {
  isDragging: boolean;
  dragHandlers: FileDropHandlers;
};

function hasFiles(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes("Files");
}

export function useFileDrop(onDrop: (files: File[]) => void): UseFileDropReturn {
  const [isDragging, setIsDragging] = useState(false);
  const enterCountRef = useRef(0);
  const notifyRejected = useFileRejectionNotice();

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    enterCountRef.current += 1;

    if (enterCountRef.current === 1) {
      setIsDragging(true);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    enterCountRef.current -= 1;

    if (enterCountRef.current <= 0) {
      enterCountRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      enterCountRef.current = 0;
      setIsDragging(false);

      const droppedFiles = e.dataTransfer.files;
      if (!droppedFiles || droppedFiles.length === 0) return;

      // Global cap only. A stricter per-conversation limit (E2EE) is applied where the files land,
      // so the drop zone does not need to know what it is dropping into.
      const { accepted, rejected } = validateFiles(droppedFiles, MAX_FILE_SIZE);
      notifyRejected(rejected, { reason: "size", maxBytes: MAX_FILE_SIZE });
      if (accepted.length > 0) {
        onDrop(accepted);
      }
    },
    [onDrop, notifyRejected]
  );

  return {
    isDragging,
    dragHandlers: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}
