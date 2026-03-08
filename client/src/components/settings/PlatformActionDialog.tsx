/** PlatformActionDialog — Reusable confirmation dialog with optional reason textarea. */

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

type PlatformActionDialogProps = {
  title: string;
  description: string;
  reasonLabel: string;
  reasonPlaceholder: string;
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
};

function PlatformActionDialog({
  title,
  description,
  reasonLabel,
  reasonPlaceholder,
  confirmLabel,
  onConfirm,
  onCancel,
}: PlatformActionDialogProps) {
  const { t } = useTranslation("settings");
  const [reason, setReason] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onConfirm(reason.trim());
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card platform-action-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
        </div>
        <p className="modal-text">{description}</p>

        <form onSubmit={handleSubmit}>
          <label className="platform-ban-label">
            {reasonLabel}
          </label>
          <textarea
            ref={textareaRef}
            className="platform-ban-textarea"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reasonPlaceholder}
            rows={3}
            maxLength={500}
          />

          <div className="modal-actions">
            <button
              type="button"
              className="settings-btn settings-btn-secondary"
              onClick={onCancel}
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              className="settings-btn settings-btn-danger"
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

export default PlatformActionDialog;
