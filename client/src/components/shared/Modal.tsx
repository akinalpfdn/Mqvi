/**
 * Modal — Reusable modal component.
 *
 * Kullanım:
 *   <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Kanal Oluştur">
 *     <form>...</form>
 *   </Modal>
 *
 * Özellikler:
 * - Backdrop tıklamasıyla kapanır
 * - Escape tuşuyla kapanır
 * - Body scroll'u kilitler (modal açıkken arka plan scroll olmaz)
 * - Animasyonlu giriş/çıkış (opacity transition)
 */

import { useEffect, useCallback, type ReactNode } from "react";

type ModalProps = {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
};

function Modal({ isOpen, onClose, title, children }: ModalProps) {
  // Escape tuşuyla kapatma
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (!isOpen) return;

    document.addEventListener("keydown", handleKeyDown);
    // Body scroll kilidi
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 transition-opacity"
        onClick={onClose}
      />

      {/* Modal content */}
      <div className="relative w-full max-w-md rounded-md bg-background-secondary p-4 shadow-xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-text-primary">{title}</h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Body */}
        {children}
      </div>
    </div>
  );
}

export default Modal;
