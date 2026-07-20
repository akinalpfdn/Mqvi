/**
 * Upload progress readout — bar, sent/total bytes, percentage, and a cancel control.
 *
 * `total` is null when the browser cannot compute the body length; the bar then runs indeterminate
 * rather than showing a percentage that would be a guess.
 */

import { useTranslation } from "react-i18next";
import { formatBytes } from "../../utils/formatBytes";

type UploadProgressProps = {
  loaded: number;
  total: number | null;
  onCancel?: () => void;
};

function UploadProgress({ loaded, total, onCancel }: UploadProgressProps) {
  const { t } = useTranslation("common");

  const hasTotal = total !== null && total > 0;
  const percent = hasTotal ? Math.min(100, Math.round((loaded / total) * 100)) : null;

  // Nothing on the wire yet — the send may still be encrypting, so "0 B sent" would mislead.
  const label = hasTotal
    ? t("uploadingProgress", {
        sent: formatBytes(loaded),
        total: formatBytes(total),
        percent,
      })
    : loaded === 0
      ? t("uploadPreparing")
      : t("uploadingSent", { sent: formatBytes(loaded) });

  return (
    <div className="upload-progress">
      <div
        className="upload-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span
          className={`upload-progress-fill${percent === null ? " indeterminate" : ""}`}
          // A data-driven width cannot be a theme token; it rides a custom property so the rule
          // itself stays in the stylesheet.
          style={percent === null ? undefined : ({ "--upload-pct": `${percent}%` } as React.CSSProperties)}
        />
      </div>

      <span className="upload-progress-text">{label}</span>

      {onCancel && (
        <button
          type="button"
          className="upload-progress-cancel"
          onClick={onCancel}
          aria-label={t("cancel")}
          title={t("cancel")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

export default UploadProgress;
