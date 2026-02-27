/**
 * MobileBottomSheet — Reusable mobile bottom sheet overlay.
 *
 * Ekranın altından yukarı kayarak açılır.
 * Backdrop tıklaması ile kapanır.
 * Portal ile document.body'ye render edilir.
 *
 * Kullanım:
 * ```tsx
 * <MobileBottomSheet isOpen={open} onClose={() => setOpen(false)}>
 *   <div>İçerik</div>
 * </MobileBottomSheet>
 * ```
 *
 * CSS class'ları: .mobile-bottom-sheet, .mobile-bottom-sheet-backdrop,
 * .mobile-bottom-sheet-handle, .mobile-bs-action, .mobile-bs-action-icon
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";

type MobileBottomSheetProps = {
  /** Bottom sheet açık mı? */
  isOpen: boolean;
  /** Kapatma callback'i */
  onClose: () => void;
  /** İçerik */
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
