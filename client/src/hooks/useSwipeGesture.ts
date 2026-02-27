/**
 * useSwipeGesture — Yatay swipe detection hook'u.
 *
 * Touch event'lerini takip eder ve belirli eşikleri aştığında
 * onSwipeLeft / onSwipeRight callback'lerini çağırır.
 *
 * Özellikler:
 * - Minimum mesafe eşiği (threshold, varsayılan 50px)
 * - Hız eşiği (velocityThreshold, varsayılan 0.3 px/ms)
 * - Edge-only mod (edgeWidth > 0 ise sadece ekran kenarından başlayan swipe'lar)
 * - Dikey scroll ile çakışma önleme (dikey hareket > yatay ise iptal)
 *
 * Kullanım:
 * ```tsx
 * const swipeHandlers = useSwipeGesture({
 *   onSwipeRight: () => openSidebar(),
 *   edgeWidth: 20, // sadece sol kenardan
 * });
 * <div {...swipeHandlers}>...</div>
 * ```
 */

import { useCallback, useRef } from "react";

type SwipeConfig = {
  /** Sağa swipe callback */
  onSwipeRight?: () => void;
  /** Sola swipe callback */
  onSwipeLeft?: () => void;
  /** Minimum swipe mesafesi (px). Varsayılan: 50 */
  threshold?: number;
  /** Minimum swipe hızı (px/ms). Varsayılan: 0.3 */
  velocityThreshold?: number;
  /**
   * Edge trigger genişliği (px). 0 = her yerden swipe kabul.
   * Pozitif değer = sadece ilgili kenardan başlayan swipe'lar:
   * - onSwipeRight varsa: sol kenardan (0 → edgeWidth)
   * - onSwipeLeft varsa: sağ kenardan (viewport - edgeWidth → viewport)
   */
  edgeWidth?: number;
};

type SwipeHandlers = {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
};

type SwipeState = {
  startX: number;
  startY: number;
  startTime: number;
  /** true = swipe iptal (dikey hareket baskın) */
  cancelled: boolean;
  /** true = edge kontrolünü geçti */
  edgeValid: boolean;
};

function useSwipeGesture(config: SwipeConfig): SwipeHandlers {
  const {
    onSwipeRight,
    onSwipeLeft,
    threshold = 50,
    velocityThreshold = 0.3,
    edgeWidth = 0,
  } = config;

  const stateRef = useRef<SwipeState | null>(null);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      const x = touch.clientX;

      // Edge kontrolü — sadece belirli kenardan başlayan swipe'ları kabul et
      let edgeValid = true;
      if (edgeWidth > 0) {
        const vw = window.innerWidth;
        const fromLeftEdge = x <= edgeWidth;
        const fromRightEdge = x >= vw - edgeWidth;

        // En az bir kenar koşulunu sağlamalı
        edgeValid =
          (!!onSwipeRight && fromLeftEdge) ||
          (!!onSwipeLeft && fromRightEdge);
      }

      stateRef.current = {
        startX: x,
        startY: touch.clientY,
        startTime: Date.now(),
        cancelled: false,
        edgeValid,
      };
    },
    [edgeWidth, onSwipeRight, onSwipeLeft]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const state = stateRef.current;
      if (!state || state.cancelled) return;

      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - state.startX);
      const dy = Math.abs(touch.clientY - state.startY);

      // Dikey hareket baskınsa swipe iptal — kullanıcı scroll yapıyor
      if (dy > dx && dy > 10) {
        state.cancelled = true;
      }
    },
    []
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const state = stateRef.current;
      if (!state || state.cancelled || !state.edgeValid) {
        stateRef.current = null;
        return;
      }

      const touch = e.changedTouches[0];
      const dx = touch.clientX - state.startX;
      const absDx = Math.abs(dx);
      const elapsed = Date.now() - state.startTime;
      const velocity = elapsed > 0 ? absDx / elapsed : 0;

      // Eşikleri kontrol et
      if (absDx >= threshold && velocity >= velocityThreshold) {
        if (dx > 0 && onSwipeRight) {
          onSwipeRight();
        } else if (dx < 0 && onSwipeLeft) {
          onSwipeLeft();
        }
      }

      stateRef.current = null;
    },
    [threshold, velocityThreshold, onSwipeRight, onSwipeLeft]
  );

  return { onTouchStart, onTouchMove, onTouchEnd };
}

export { useSwipeGesture };
export type { SwipeConfig, SwipeHandlers };
