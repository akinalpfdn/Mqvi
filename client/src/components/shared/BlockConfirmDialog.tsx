/** BlockConfirmDialog — Block confirmation with an opt-in "also report this user" step. */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

type BlockConfirmDialogProps = {
  username: string;
  /** Called with the checkbox value; the caller blocks, then opens ReportModal when asked. */
  onConfirm: (alsoReport: boolean) => void;
  onClose: () => void;
};

function BlockConfirmDialog({ username, onConfirm, onClose }: BlockConfirmDialogProps) {
  const { t } = useTranslation("dm");
  const { t: tCommon } = useTranslation("common");
  const [alsoReport, setAlsoReport] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop modal-backdrop-confirm" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{t("blockConfirmTitle", { username })}</h2>
        </div>

        <p className="modal-text">{t("blockConfirmMessage")}</p>

        <label className="block-confirm-check">
          <input
            type="checkbox"
            checked={alsoReport}
            onChange={(e) => setAlsoReport(e.target.checked)}
          />
          <span>
            {t("blockAlsoReport")}
            <span className="block-confirm-hint">{t("blockAlsoReportHint")}</span>
          </span>
        </label>

        <div className="modal-actions">
          <button className="settings-btn settings-btn-secondary" onClick={onClose}>
            {tCommon("cancel")}
          </button>
          <button
            className="settings-btn settings-btn-danger"
            onClick={() => onConfirm(alsoReport)}
            autoFocus
          >
            {t("blockConfirmButton")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default BlockConfirmDialog;
