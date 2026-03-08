/** PlatformBanDialog — Ban confirmation dialog with reason textarea and delete-messages toggle. */

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

type PlatformBanDialogProps = {
  username: string;
  onConfirm: (reason: string, deleteMessages: boolean) => void;
  onCancel: () => void;
};

function PlatformBanDialog({ username, onConfirm, onCancel }: PlatformBanDialogProps) {
  const { t } = useTranslation("settings");
  const [reason, setReason] = useState("");
  const [deleteMessages, setDeleteMessages] = useState(false);
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
    onConfirm(reason.trim(), deleteMessages);
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card platform-ban-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{t("platformBanTitle")}</h2>
        </div>
        <p className="modal-text">
          {t("platformBanDescription", { username })}
        </p>

        <form onSubmit={handleSubmit}>
          <label className="platform-ban-label">
            {t("platformBanReasonLabel")}
          </label>
          <textarea
            ref={textareaRef}
            className="platform-ban-textarea"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t("platformBanReasonPlaceholder")}
            rows={3}
            maxLength={500}
          />

          <label className="platform-ban-checkbox-label">
            <input
              type="checkbox"
              checked={deleteMessages}
              onChange={(e) => setDeleteMessages(e.target.checked)}
            />
            <span>{t("platformBanDeleteMessages")}</span>
          </label>

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
              {t("platformBanConfirm")}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}

export default PlatformBanDialog;
