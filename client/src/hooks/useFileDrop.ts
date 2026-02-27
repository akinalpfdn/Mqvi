/**
 * useFileDrop — Drag-and-drop dosya yükleme hook'u.
 *
 * PanelView'daki tab drag-drop pattern'ından farklı:
 * - Tab drop: "text/tab-id" MIME type kontrol eder
 * - File drop: dataTransfer.files kontrol eder
 *
 * enterCount pattern: PanelView ile aynı — nested child element'lerin
 * yanlış dragLeave tetiklemesini engeller. Her child'a girişte counter artar,
 * çıkışta azalır. 0'a düşünce gerçekten çıkmış demektir.
 *
 * Tab sürükleme ile çakışma yok: Tab sürüklemesinde dataTransfer.files boştur,
 * bu hook sadece dosya sürüklendiğinde aktifleşir.
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
  /** Dosya sürüklenirken true — overlay göstermek için */
  isDragging: boolean;
  /** Container div'e spread edilecek event handler'ları */
  dragHandlers: FileDropHandlers;
};

/**
 * hasFiles — Drag event'inde dosya olup olmadığını kontrol eder.
 * Tab sürüklemesi (text/tab-id) ile karışmaması için types listesinde "Files" arar.
 */
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
