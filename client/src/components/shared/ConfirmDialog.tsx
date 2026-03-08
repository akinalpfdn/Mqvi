/** ConfirmDialog — Custom confirm dialog replacing window.confirm(). Reads from confirmStore, renders nothing when null. */

import { useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmStore } from "../../stores/confirmStore";

function ConfirmDialog() {
  const { t } = useTranslation("common");
  const options = useConfirmStore((s) => s.options);
  const confirmAction = useConfirmStore((s) => s.confirm);
  const cancelAction = useConfirmStore((s) => s.cancel);

  // Close on Escape
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
        {/* Title */}
        {options.title && (
          <div className="modal-header">
            <h2 className="modal-title">{options.title}</h2>
          </div>
        )}

        {/* Message */}
        <p className="modal-text">{options.message}</p>

        {/* Actions */}
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
