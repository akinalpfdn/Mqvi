/** MobileBottomSheet — Slides up from bottom, closes on backdrop click. Portaled to body. */

import { useEffect } from "react";
import { createPortal } from "react-dom";

type MobileBottomSheetProps = {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
};

function MobileBottomSheet({ isOpen, onClose, children }: MobileBottomSheetProps) {
  // Body scroll lock
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
        className={`mobile-bottom-sheet-backdrop${isOpen ? " open" : ""}`}
        onClick={onClose}
      />
      <div className={`mobile-bottom-sheet${isOpen ? " open" : ""}`}>
        <div className="mobile-bottom-sheet-handle" />
        {children}
      </div>
    </>,
    document.body
  );
}

export default MobileBottomSheet;
