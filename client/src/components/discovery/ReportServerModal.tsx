import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { reportServer } from "../../api/discovery";
import { useToastStore } from "../../stores/toastStore";

/** Report reasons matching the backend enum (labels live in the `dm` namespace). */
const REASONS = [
  { value: "spam", key: "reportReasonSpam" },
  { value: "harassment", key: "reportReasonHarassment" },
  { value: "inappropriate_content", key: "reportReasonInappropriate" },
  { value: "impersonation", key: "reportReasonImpersonation" },
  { value: "other", key: "reportReasonOther" },
];

type Props = {
  serverId: string;
  serverName: string;
  onClose: () => void;
};

function ReportServerModal({ serverId, serverName, onClose }: Props) {
  const { t } = useTranslation("dm");
  const { t: tDisc } = useTranslation("discovery");
  const addToast = useToastStore((s) => s.addToast);

  const [reason, setReason] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isValid = reason !== null && description.trim().length >= 10;

  async function handleSubmit() {
    if (!isValid || !reason || submitting) return;
    setSubmitting(true);
    const res = await reportServer(serverId, reason, description.trim());
    setSubmitting(false);
    if (res.success) {
      addToast("success", t("reportSubmitted"));
      onClose();
    } else if (res.error?.includes("already")) {
      addToast("warning", t("alreadyReported"));
      onClose();
    } else {
      addToast("error", res.error ?? tDisc("reportError"));
    }
  }

  return createPortal(
    <div
      className="report-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="report-modal">
        <div className="report-header">
          <h2 className="report-title">{tDisc("reportServerTitle", { server: serverName })}</h2>
          <button className="report-close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="report-body">
          <div className="report-field">
            <label className="report-label">{t("reportReasonLabel")}</label>
            <div className="report-reasons">
              {REASONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  className={`report-reason-item${reason === r.value ? " selected" : ""}`}
                  onClick={() => setReason(r.value)}
                >
                  <span className="report-reason-radio">
                    <span className="report-reason-radio-dot" />
                  </span>
                  <span className="report-reason-label">{t(r.key)}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="report-field">
            <label className="report-label">{t("reportDescriptionLabel")}</label>
            <textarea
              className="report-textarea"
              placeholder={t("reportDescriptionPlaceholder")}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1000}
            />
          </div>

          <div className="report-actions">
            <button className="report-btn report-btn-cancel" onClick={onClose}>
              {t("reportCancel")}
            </button>
            <button
              className="report-btn report-btn-submit"
              onClick={handleSubmit}
              disabled={!isValid || submitting}
            >
              {t("reportSubmit")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default ReportServerModal;
