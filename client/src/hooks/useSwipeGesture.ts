/**
 * useSwipeGesture — Horizontal swipe detection hook.
 *
 * Features:
 * - Minimum distance threshold (default 50px)
 * - Velocity threshold (default 0.3 px/ms)
 * - Edge-only mode (edgeWidth > 0: only swipes starting from screen edge)
 * - Vertical scroll conflict prevention (cancels if vertical > horizontal)
 */

import { useCallback, useRef } from "react";

type SwipeConfig = {
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
  threshold?: number;
  velocityThreshold?: number;
  /**
   * Edge trigger width (px). 0 = accept swipe from anywhere.
   * Positive = only from relevant edge (left for swipeRight, right for swipeLeft).
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
  cancelled: boolean;
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

      let edgeValid = true;
      if (edgeWidth > 0) {
        const vw = window.innerWidth;
        const fromLeftEdge = x <= edgeWidth;
        const fromRightEdge = x >= vw - edgeWidth;

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

      // Cancel if vertical movement dominates — user is scrolling
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
