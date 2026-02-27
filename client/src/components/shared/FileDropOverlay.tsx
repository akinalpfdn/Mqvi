/**
 * FileDropOverlay — Dosya sürüklenirken gösterilen görsel overlay.
 *
 * pointer-events: none ile tüm mouse event'leri alt katmana geçer.
 * Sadece görsel feedback sağlar — drop handling parent'ta yapılır.
 *
 * CSS class'ları: .file-drop-overlay, .file-drop-overlay-content
 */

import { useTranslation } from "react-i18next";

function FileDropOverlay() {
  const { t } = useTranslation("chat");

  return (
    <div className="file-drop-overlay">
      <div className="file-drop-overlay-content">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <span>{t("dropFilesHere")}</span>
      </div>
    </div>
  );
}

export default FileDropOverlay;
