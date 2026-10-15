/**
 * useLongPress — Touch long-press detection hook.
 *
 * Fires callback after holding for `delay` ms (default 500).
 * Cancelled if finger moves beyond threshold (10px), lifts, or the system takes the touch over.
 * The lift that ends a long press is not also a tap.
 * Prevents native context menu on mobile.
 */

import { useCallback, useRef } from "react";

type LongPressCallback = (position: { clientX: number; clientY: number; target: Element }) => void;

type LongPressOptions = {
  delay?: number;
  moveThreshold?: number;
};

type LongPressHandlers = {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
};

function useLongPress(
  callback: LongPressCallback,
  options?: LongPressOptions
): LongPressHandlers {
  const { delay = 500, moveThreshold = 10 } = options ?? {};

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      // One hook can serve a whole list; a new touch replaces a press still pending on another row.
      clear();
      firedRef.current = false;
      const touch = e.touches[0];
      const target = e.currentTarget;
      startPosRef.current = { x: touch.clientX, y: touch.clientY };

      timerRef.current = setTimeout(() => {
        firedRef.current = true;
        callback({ clientX: touch.clientX, clientY: touch.clientY, target });
        timerRef.current = null;
      }, delay);
    },
    [callback, delay, clear]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!startPosRef.current) return;

      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - startPosRef.current.x);
      const dy = Math.abs(touch.clientY - startPosRef.current.y);

      if (dx > moveThreshold || dy > moveThreshold) {
        clear();
      }
    },
    [moveThreshold, clear]
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      clear();
      // The finger lifting after a long press would click whatever is under it, on top of the menu.
      // Spent here: a later touch this hook never started must not inherit it.
      if (firedRef.current) {
        firedRef.current = false;
        e.preventDefault();
      }
    },
    [clear]
  );

  // A scroll or a system gesture took the touch: no long press can follow.
  const onTouchCancel = useCallback(() => {
    clear();
    firedRef.current = false;
  }, [clear]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, onContextMenu };
}

export { useLongPress };
export type { LongPressCallback, LongPressOptions, LongPressHandlers };
