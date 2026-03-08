/**
 * useResizeHandle — Drag-to-resize panel width hook.
 *
 * direction: "right" = drag right to widen (left sidebar),
 *            "left"  = drag left to widen (right sidebar).
 *
 * Mouse events are on document level so drag continues outside the handle.
 * user-select: none applied during drag to prevent text selection.
 * Disabled on mobile.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useIsMobile } from "./useMediaQuery";

type ResizeHandleOptions = {
  initialWidth: number;
  minWidth: number;
  maxWidth: number;
  direction: "right" | "left";
  storageKey: string;
  onWidthChange?: (width: number) => void;
};

type ResizeHandleResult = {
  width: number;
  handleMouseDown: (e: React.MouseEvent) => void;
  isDragging: boolean;
};

function loadWidth(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    /* localStorage access error */
  }
  return null;
}

function saveWidth(key: string, width: number): void {
  try {
    localStorage.setItem(key, String(Math.round(width)));
  } catch {
    /* localStorage full */
  }
}

const NOOP_MOUSE_DOWN = () => {};

export function useResizeHandle(options: ResizeHandleOptions): ResizeHandleResult {
  const { initialWidth, minWidth, maxWidth, direction, storageKey, onWidthChange } = options;
  const isMobile = useIsMobile();

  const [width, setWidth] = useState(() => {
    const saved = loadWidth(storageKey);
    if (saved !== null) {
      return Math.min(Math.max(saved, minWidth), maxWidth);
    }
    return initialWidth;
  });

  const [isDragging, setIsDragging] = useState(false);

  /** Refs to avoid stale closures in event listeners */
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (isMobile) return;

      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      setIsDragging(true);

      document.body.style.userSelect = "none";
      document.body.style.cursor = direction === "right" ? "col-resize" : "col-resize";
    },
    [width, direction, isMobile]
  );

  useEffect(() => {
    if (!isDragging || isMobile) return;

    function handleMouseMove(e: MouseEvent) {
      const delta = e.clientX - startXRef.current;
      const newWidth =
        direction === "right"
          ? startWidthRef.current + delta
          : startWidthRef.current - delta;

      const clamped = Math.min(Math.max(newWidth, minWidth), maxWidth);
      setWidth(clamped);
      onWidthChange?.(clamped);
    }

    function handleMouseUp() {
      setIsDragging(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, isMobile, direction, minWidth, maxWidth, onWidthChange]);

  /** Persist width when drag ends (isDragging transitions false) */
  const prevDraggingRef = useRef(false);
  useEffect(() => {
    if (prevDraggingRef.current && !isDragging) {
      saveWidth(storageKey, width);
    }
    prevDraggingRef.current = isDragging;
  }, [isDragging, width, storageKey]);

  if (isMobile) {
    return { width, handleMouseDown: NOOP_MOUSE_DOWN, isDragging: false };
  }

  return { width, handleMouseDown, isDragging };
}
