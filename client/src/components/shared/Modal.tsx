/**
 * Modal — Reusable modal component.
 *
 * CSS class'ları: .modal-backdrop, .modal-card, .modal-title, .modal-actions
 *
 * Özellikler:
 * - Backdrop tıklamasıyla kapanır
 * - Escape tuşuyla kapanır
 * - Body scroll'u kilitler
 */

import { useEffect, useCallback, type ReactNode } from "react";

type ModalProps = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
};

function Modal({ isOpen, onClose, title, children }: ModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (!isOpen) return;

    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      {/* Modal content — tıklama yayılmasını engelle */}
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h2 className="modal-title" style={{ marginBottom: 0 }}>{title}</h2>
          <button onClick={onClose} className="toast-close">
            ✕
          </button>
        </div>

        {/* Body */}
        {children}
      </div>
    </div>
  );
}

export default Modal;
