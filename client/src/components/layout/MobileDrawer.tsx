/**
 * MobileDrawer — Slide-in drawer from left or right edge.
 *
 * Portaled to document.body. Locks body scroll while open.
 * Backdrop click closes the drawer.
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";

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

  return createPortal(
    <>
      <div
        className={`mobile-drawer-backdrop${isOpen ? " open" : ""}`}
        onClick={onClose}
      />
      <div className={`mobile-drawer ${side}${isOpen ? " open" : ""}`}>
        {children}
      </div>
    </>,
    document.body
  );
}

export default MobileDrawer;
