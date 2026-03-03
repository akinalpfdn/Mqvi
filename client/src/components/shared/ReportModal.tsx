/**
 * ReportModal — Kullanıcı raporlama modalı.
 *
 * 5 predefined reason radio button + zorunlu description textarea.
 * Submit: reportApi.reportUser() → success toast → close.
 *
 * CSS class'ları: .report-overlay, .report-modal, .report-header,
 * .report-body, .report-field, .report-reasons, .report-reason-item,
 * .report-textarea, .report-actions, .report-btn-*
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { reportUser, type ReportReason } from "../../api/report";
import { useToastStore } from "../../stores/toastStore";

type ReportModalProps = {
  userId: string;
  username: string;
  onClose: () => void;
};

/** Predefined report reasons — backend'in kabul ettiği değerler */
const REASONS: { value: ReportReason; key: string }[] = [
  { value: "spam", key: "reportReasonSpam" },
  { value: "harassment", key: "reportReasonHarassment" },
  { value: "inappropriate_content", key: "reportReasonInappropriate" },
  { value: "impersonation", key: "reportReasonImpersonation" },
  { value: "other", key: "reportReasonOther" },
];

function ReportModal({ userId, username, onClose }: ReportModalProps) {
  const { t } = useTranslation("dm");
  const addToast = useToastStore((s) => s.addToast);

  const [selectedReason, setSelectedReason] = useState<ReportReason | null>(null);
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isValid = selectedReason !== null && description.trim().length >= 10;

  async function handleSubmit() {
    if (!isValid || !selectedReason || isSubmitting) return;

    setIsSubmitting(true);
    const res = await reportUser(userId, {
      reason: selectedReason,
      description: description.trim(),
    });

    if (res.success) {
      addToast("success", t("reportSubmitted"));
      onClose();
    } else if (res.error?.includes("already")) {
      addToast("warning", t("alreadyReported"));
      onClose();
    }
    setIsSubmitting(false);
  }

  // Overlay tıklaması ile kapatma (modal içine tıklamayı durdur)
  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="report-overlay" onClick={handleOverlayClick}>
      <div className="report-modal">
        {/* Header */}
        <div className="report-header">
          <h2 className="report-title">
            {t("reportTitle", { username })}
          </h2>
          <button className="report-close" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="report-body">
          {/* Reason Selection */}
          <div className="report-field">
            <label className="report-label">{t("reportReasonLabel")}</label>
            <div className="report-reasons">
              {REASONS.map((r) => (
                <button
                  key={r.value}
                  className={`report-reason-item${selectedReason === r.value ? " selected" : ""}`}
                  onClick={() => setSelectedReason(r.value)}
                  type="button"
                >
                  <span className="report-reason-radio">
                    <span className="report-reason-radio-dot" />
                  </span>
                  <span className="report-reason-label">{t(r.key)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Description */}
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

          {/* Actions */}
          <div className="report-actions">
            <button className="report-btn report-btn-cancel" onClick={onClose}>
              {t("reportCancel")}
            </button>
            <button
              className="report-btn report-btn-submit"
              onClick={handleSubmit}
              disabled={!isValid || isSubmitting}
            >
              {t("reportSubmit")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ReportModal;
