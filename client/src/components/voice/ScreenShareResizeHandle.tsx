/**
 * ScreenShareResizeHandle — Draggable divider between two screen share panels.
 *
 * Uses Pointer Events API with pointer capture so fast drags don't lose the handle.
 * Reports pixel deltas to parent which converts them to percentages.
 */

import { useRef, useCallback } from "react";

type ScreenShareResizeHandleProps = {
  direction: "vertical" | "horizontal";
  /** Called during drag with pixel delta */
  onResize: (delta: number) => void;
};

function ScreenShareResizeHandle({ direction, onResize }: ScreenShareResizeHandleProps) {
  // Refs instead of state to avoid re-renders on every mouse move
  const lastPosRef = useRef(0);
  const isDraggingRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      isDraggingRef.current = true;
      lastPosRef.current = direction === "vertical" ? e.clientY : e.clientX;
      e.preventDefault();
    },
    [direction]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDraggingRef.current) return;

      const currentPos = direction === "vertical" ? e.clientY : e.clientX;
      const delta = currentPos - lastPosRef.current;
      lastPosRef.current = currentPos;

      if (delta !== 0) {
        onResize(delta);
      }
    },
    [direction, onResize]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      isDraggingRef.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    []
  );

  const handleClass = `screen-share-resize ${direction}`;

  return (
    <div
      className={handleClass}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{ touchAction: "none" }}
    >
      <div className="screen-share-resize-line" />
    </div>
  );
}

export default ScreenShareResizeHandle;
