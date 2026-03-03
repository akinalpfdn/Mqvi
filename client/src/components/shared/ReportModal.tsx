/**
 * ReportModal — Kullanıcı raporlama modalı.
 *
 * 5 predefined reason radio button + zorunlu description textarea + opsiyonel resim delilleri.
 * Submit: reportApi.reportUser() → success toast → close.
 *
 * Dosya ekleme: drag & drop (useFileDrop) + paste (clipboard) + file input.
 * FilePreview component'i ile önizleme gösterilir.
 * Sadece resimler kabul edilir (image/*), max 4 dosya.
 *
 * CSS class'ları: .report-overlay, .report-modal, .report-header,
 * .report-body, .report-field, .report-reasons, .report-reason-item,
 * .report-textarea, .report-actions, .report-btn-*,
 * .report-evidence, .report-evidence-drop, .report-evidence-hint
 */

import { useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { reportUser, type ReportReason } from "../../api/report";
import { useToastStore } from "../../stores/toastStore";
import { useFileDrop } from "../../hooks/useFileDrop";
import FilePreview from "../chat/FilePreview";

type ReportModalProps = {
  userId: string;
  username: string;
  onClose: () => void;
};

/** Max dosya sayısı — rapor başına delil limiti */
const MAX_EVIDENCE_FILES = 4;

/** Sadece resimler kabul edilir — delil screenshotları için yeterli */
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/** Predefined report reasons — backend'in kabul ettiği değerler */
const REASONS: { value: ReportReason; key: string }[] = [
  { value: "spam", key: "reportReasonSpam" },
  { value: "harassment", key: "reportReasonHarassment" },
  { value: "inappropriate_content", key: "reportReasonInappropriate" },
  { value: "impersonation", key: "reportReasonImpersonation" },
  { value: "other", key: "reportReasonOther" },
];

/** Sadece resim dosyalarını filtreler (image/*) */
function filterImageFiles(files: File[]): File[] {
  return files.filter((f) => ALLOWED_IMAGE_TYPES.includes(f.type));
}

function ReportModal({ userId, username, onClose }: ReportModalProps) {
  const { t } = useTranslation("dm");
  const addToast = useToastStore((s) => s.addToast);

  const [selectedReason, setSelectedReason] = useState<ReportReason | null>(null);
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isValid = selectedReason !== null && description.trim().length >= 10;

  /** Dosya ekleme — max limit kontrolü ile */
  const addFiles = useCallback(
    (newFiles: File[]) => {
      const images = filterImageFiles(newFiles);
      if (images.length === 0) return;

      setFiles((prev) => {
        const remaining = MAX_EVIDENCE_FILES - prev.length;
        if (remaining <= 0) {
          addToast("warning", t("reportMaxFiles"));
          return prev;
        }
        const toAdd = images.slice(0, remaining);
        if (images.length > remaining) {
          addToast("warning", t("reportMaxFiles"));
        }
        return [...prev, ...toAdd];
      });
    },
    [addToast, t]
  );

  /** Dosya kaldırma */
  function handleRemoveFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  /** Drag & drop hook — useFileDrop validateFiles kullanır, biz ek olarak image filtresi uyguluyoruz */
  const { isDragging, dragHandlers } = useFileDrop((droppedFiles) => {
    addFiles(droppedFiles);
  });

  /** Clipboard paste desteği — MessageInput pattern */
  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    const pastedFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) pastedFiles.push(file);
      }
    }

    if (pastedFiles.length > 0) {
      addFiles(pastedFiles);
    }
  }

  /** File input change — tıklayarak dosya seçme */
  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;
    addFiles(Array.from(e.target.files));
    e.target.value = "";
  }

  async function handleSubmit() {
    if (!isValid || !selectedReason || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const res = await reportUser(
        userId,
        { reason: selectedReason, description: description.trim() },
        files.length > 0 ? files : undefined
      );

      if (res.success) {
        addToast("success", t("reportSubmitted"));
        onClose();
      } else if (res.error?.includes("already")) {
        addToast("warning", t("alreadyReported"));
        onClose();
      } else {
        addToast("error", res.error ?? "Failed to submit report");
      }
    } catch {
      addToast("error", "Failed to submit report");
    } finally {
      setIsSubmitting(false);
    }
  }

  // Overlay tıklaması ile kapatma (modal içine tıklamayı durdur)
  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="report-overlay" onClick={handleOverlayClick}>
      <div className="report-modal" {...dragHandlers} onPaste={handlePaste}>
        {/* Drag overlay — dosya sürüklenirken gösterilir */}
        {isDragging && (
          <div className="file-drop-overlay">
            <span className="file-drop-text">{t("reportEvidenceHint")}</span>
          </div>
        )}

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

          {/* Evidence — opsiyonel resim delilleri */}
          <div className="report-field">
            <label className="report-label">{t("reportEvidenceLabel")}</label>

            {files.length > 0 && (
              <FilePreview files={files} onRemove={handleRemoveFile} />
            )}

            {files.length < MAX_EVIDENCE_FILES && (
              <button
                type="button"
                className="report-evidence-drop"
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="report-evidence-hint">{t("reportEvidenceHint")}</span>
              </button>
            )}

            {/* Hidden file input — tıklama ile dosya seçimi */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              style={{ display: "none" }}
              onChange={handleFileInputChange}
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
