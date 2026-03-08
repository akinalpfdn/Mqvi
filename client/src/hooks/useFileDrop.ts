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

      const valid = validateFiles(droppedFiles);
      if (valid.length > 0) {
        onDrop(valid);
      }
    },
    [onDrop]
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
