/** DownloadPromptModal — One-time modal after first login on web browser. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { detectOS, shouldShowDownloadPrompt } from "../../utils/detectOS";
import { dismissDownloadPrompt } from "../../api/auth";

function DownloadPromptModal() {
  const { t } = useTranslation("auth");
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const [dismissed, setDismissed] = useState(false);

  if (!user || user.has_seen_download_prompt || dismissed || !shouldShowDownloadPrompt()) {
    return null;
  }

  const { url, i18nKey } = detectOS();

  function handleDismiss() {
    setDismissed(true);
    updateUser({ has_seen_download_prompt: true });
    dismissDownloadPrompt();
  }

  return (
    <div className="download-prompt-overlay" onClick={handleDismiss}>
      <div className="download-prompt-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("downloadPromptTitle")}</h3>
        <p>{t("downloadPromptDesc")}</p>
        <div className="download-prompt-actions">
          <a
            href={url}
            className="download-prompt-btn-primary"
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleDismiss}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {t(i18nKey)}
          </a>
          <button className="download-prompt-btn-dismiss" onClick={handleDismiss}>
            {t("downloadPromptDismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default DownloadPromptModal;
