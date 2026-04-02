/**
 * MobileDrawer — Slide-in drawer from left or right edge.
 *
 * Portaled to document.body. Locks body scroll while open.
 * Backdrop click or swipe in closing direction closes the drawer.
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useSwipeGesture } from "../../hooks/useSwipeGesture";

type MobileDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  side: "left" | "right";
  children: React.ReactNode;
};

function MobileDrawer({ isOpen, onClose, side, children }: MobileDrawerProps) {
  // Lock body scroll while open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [isOpen]);

  // Swipe to close: left drawer → swipe left, right drawer → swipe right
  const swipeHandlers = useSwipeGesture({
    onSwipeLeft: side === "left" ? onClose : undefined,
    onSwipeRight: side === "right" ? onClose : undefined,
    threshold: 30,
    velocityThreshold: 0.15,
  });

  return createPortal(
    <>
      <div
        className={`mobile-drawer-backdrop${isOpen ? " open" : ""}`}
        onClick={onClose}
      />
      <div
        className={`mobile-drawer ${side}${isOpen ? " open" : ""}`}
        {...swipeHandlers}
      >
        {children}
      </div>
    </>,
    document.body
  );
}

export default MobileDrawer;
