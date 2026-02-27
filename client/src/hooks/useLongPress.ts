/**
 * useLongPress — Touch long-press detection hook'u.
 *
 * Belirli süre (varsayılan 500ms) boyunca basılı tutulursa callback çağırılır.
 * Parmak hareket ederse (10px+) veya kaldırılırsa iptal olur.
 *
 * Kullanım:
 * ```tsx
 * const longPressHandlers = useLongPress((e) => {
 *   openContextMenu(e.clientX, e.clientY);
 * });
 * <div {...longPressHandlers}>...</div>
 * ```
 *
 * Context menu default'unu engeller (mobilde browser'ın kendi menüsü açılmasın).
 */

import { useCallback, useRef } from "react";

type LongPressCallback = (position: { clientX: number; clientY: number }) => void;

type LongPressOptions = {
  /** Basılı tutma süresi (ms). Varsayılan: 500 */
  delay?: number;
  /** Hareket toleransı (px). Bu kadar hareket ederse iptal. Varsayılan: 10 */
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
  /** long-press tetiklendi mi? touchEnd'de click'i engellemek için */
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

      // Parmak hareket ettiyse long-press iptal
      if (dx > moveThreshold || dy > moveThreshold) {
        clear();
      }
    },
    [moveThreshold, clear]
  );

  const onTouchEnd = useCallback(() => {
    clear();
  }, [clear]);

  // Context menu'yu engelle — mobilde browser'ın kendi menüsü açılmasın
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  return { onTouchStart, onTouchMove, onTouchEnd, onContextMenu };
}

export { useLongPress };
export type { LongPressCallback, LongPressOptions, LongPressHandlers };
