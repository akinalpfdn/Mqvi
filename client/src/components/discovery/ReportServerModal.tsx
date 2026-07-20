import { useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { reportServer } from "../../api/discovery";
import { useUploadProgress } from "../../hooks/useUploadProgress";
import { useFileRejectionNotice } from "../../hooks/useFileRejectionNotice";
import { validateFiles } from "../../utils/fileValidation";
import { MAX_FILE_SIZE } from "../../utils/constants";
import UploadProgress from "../shared/UploadProgress";
import { useToastStore } from "../../stores/toastStore";
import { useFileDrop } from "../../hooks/useFileDrop";
import FilePreview from "../chat/FilePreview";

/** Report reasons matching the backend enum (labels live in the `dm` namespace). */
const REASONS = [
  { value: "spam", key: "reportReasonSpam" },
  { value: "harassment", key: "reportReasonHarassment" },
  { value: "inappropriate_content", key: "reportReasonInappropriate" },
  { value: "impersonation", key: "reportReasonImpersonation" },
  { value: "other", key: "reportReasonOther" },
];

const MAX_EVIDENCE_FILES = 4;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function filterImageFiles(files: File[]): File[] {
  return files.filter((f) => ALLOWED_IMAGE_TYPES.includes(f.type));
}

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
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const { progress: uploadProgress, begin: beginUpload, end: endUpload, cancel: cancelUpload } =
    useUploadProgress();
  const notifyRejected = useFileRejectionNotice();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isValid = reason !== null && description.trim().length >= 10;

  const addFiles = useCallback(
    (newFiles: File[]) => {
      const typed = filterImageFiles(newFiles);
      notifyRejected(
        newFiles.filter((f) => !typed.includes(f)),
        { reason: "type" }
      );
      const { accepted: images, rejected } = validateFiles(typed, MAX_FILE_SIZE);
      notifyRejected(rejected, { reason: "size", maxBytes: MAX_FILE_SIZE });
      if (images.length === 0) return;
      setFiles((prev) => {
        const remaining = MAX_EVIDENCE_FILES - prev.length;
        if (remaining <= 0) {
          addToast("warning", t("reportMaxFiles"));
          return prev;
        }
        if (images.length > remaining) addToast("warning", t("reportMaxFiles"));
        return [...prev, ...images.slice(0, remaining)];
      });
    },
    [addToast, t, notifyRejected]
  );

  function handleRemoveFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  const { isDragging, dragHandlers } = useFileDrop((dropped) => addFiles(dropped));

  function handlePaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const pasted: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) pasted.push(f);
      }
    }
    if (pasted.length > 0) addFiles(pasted);
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files) return;
    addFiles(Array.from(e.target.files));
    e.target.value = "";
  }

  async function handleSubmit() {
    if (!isValid || !reason || submitting) return;
    setSubmitting(true);
    const res = await reportServer(
      serverId,
      reason,
      description.trim(),
      files.length > 0 ? files : undefined,
      files.length > 0 ? beginUpload() : undefined
    );
    endUpload();
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
      className="report-overlay report-overlay-top"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="report-modal" {...dragHandlers} onPaste={handlePaste}>
        {isDragging && (
          <div className="file-drop-overlay">
            <span className="file-drop-text">{t("reportEvidenceHint")}</span>
          </div>
        )}

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

          <div className="report-field">
            <label className="report-label">{t("reportEvidenceLabel")}</label>
            {files.length > 0 && <FilePreview files={files} onRemove={handleRemoveFile} />}
            {files.length < MAX_EVIDENCE_FILES && (
              <button
                type="button"
                className="report-evidence-drop"
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="report-evidence-hint">{t("reportEvidenceHint")}</span>
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              style={{ display: "none" }}
              onChange={handleFileInputChange}
            />
          </div>

          {uploadProgress && (
            <UploadProgress
              loaded={uploadProgress.loaded}
              total={uploadProgress.total}
              onCancel={cancelUpload}
            />
          )}

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
