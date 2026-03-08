/**
 * useLongPress — Touch long-press detection hook.
 *
 * Fires callback after holding for `delay` ms (default 500).
 * Cancelled if finger moves beyond threshold (10px) or lifts.
 * Prevents native context menu on mobile.
 */

import { useCallback, useRef } from "react";

type LongPressCallback = (position: { clientX: number; clientY: number }) => void;

type LongPressOptions = {
  delay?: number;
  moveThreshold?: number;
};

type LongPressHandlers = {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
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
      firedRef.current = false;
      const touch = e.touches[0];
      startPosRef.current = { x: touch.clientX, y: touch.clientY };

      timerRef.current = setTimeout(() => {
        firedRef.current = true;
        callback({ clientX: touch.clientX, clientY: touch.clientY });
        timerRef.current = null;
      }, delay);
    },
    [callback, delay]
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

  const onTouchEnd = useCallback(() => {
    clear();
  }, [clear]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  return { onTouchStart, onTouchMove, onTouchEnd, onContextMenu };
}

export { useLongPress };
export type { LongPressCallback, LongPressOptions, LongPressHandlers };
