/**
 * ConfirmDialog — window.confirm() yerine özel tasarımlı onay dialogu.
 *
 * AppLayout'ta mount edilir (SettingsModal, ToastContainer gibi).
 * confirmStore'dan options okur — null ise render yok.
 *
 * Mevcut .modal-* CSS class'larını kullanır, ek CSS gerekmez.
 * Escape tuşu ile iptal edilir, overlay tıklama ile iptal edilir.
 */

import { useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmStore } from "../../stores/confirmStore";

function ConfirmDialog() {
  const { t } = useTranslation("common");
  const options = useConfirmStore((s) => s.options);
  const confirmAction = useConfirmStore((s) => s.confirm);
  const cancelAction = useConfirmStore((s) => s.cancel);

  // Escape tuşu ile iptal
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") cancelAction();
    },
    [cancelAction]
  );

  useEffect(() => {
    if (!options) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [options, handleKeyDown]);

  if (!options) return null;

  const confirmLabel = options.confirmLabel ?? t("confirm");
  const cancelLabel = options.cancelLabel ?? t("cancel");

  return (
    <div className="modal-backdrop" onClick={cancelAction}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Başlık */}
        {options.title && (
          <div className="modal-header">
            <h2 className="modal-title">{options.title}</h2>
          </div>
        )}

        {/* Mesaj */}
        <p className="modal-text">{options.message}</p>

        {/* Aksiyonlar */}
        <div className="modal-actions">
          <button
            className="settings-btn settings-btn-secondary"
            onClick={cancelAction}
          >
            {cancelLabel}
          </button>
          <button
            className={`settings-btn${options.danger ? " settings-btn-danger" : ""}`}
            onClick={confirmAction}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmDialog;
