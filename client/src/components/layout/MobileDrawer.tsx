/**
 * MobileDrawer — Generic mobile drawer component.
 *
 * Sol veya sağ kenardan açılan drawer overlay.
 * Portal ile document.body'ye render edilir — overflow:hidden parent'lardan kaçınır.
 *
 * Özellikler:
 * - Backdrop tıklama ile kapatma
 * - CSS transition animasyonu (transform + opacity)
 * - Body scroll lock (drawer açıkken arka plan scroll olmaz)
 *
 * CSS class'ları: .mobile-drawer, .mobile-drawer.left, .mobile-drawer.right,
 * .mobile-drawer.open, .mobile-drawer-backdrop, .mobile-drawer-backdrop.open
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";

type MobileDrawerProps = {
  /** Drawer açık mı? */
  isOpen: boolean;
  /** Kapatma callback'i (backdrop tıklaması vb.) */
  onClose: () => void;
  /** Drawer yönü */
  side: "left" | "right";
  /** Drawer içeriği */
  children: React.ReactNode;
};

function MobileDrawer({ isOpen, onClose, side, children }: MobileDrawerProps) {
  // Body scroll lock — drawer açıkken arka plan scroll olmasın
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
      {/* Backdrop — yarı saydam overlay */}
      <div
        className={`mobile-drawer-backdrop${isOpen ? " open" : ""}`}
        onClick={onClose}
      />
      {/* Drawer panel */}
      <div className={`mobile-drawer ${side}${isOpen ? " open" : ""}`}>
        {children}
      </div>
    </>,
    document.body
  );
}

export default MobileDrawer;
