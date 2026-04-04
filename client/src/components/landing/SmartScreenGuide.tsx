/**
 * SmartScreenGuide — Paginated modal shown when Windows users click the download button.
 * Explains Windows SmartScreen warning with annotated screenshots.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  onClose: () => void;
  downloadUrl: string;
};

const PAGES = [
  { img: "/smartscreen-1.png", textKey: "ss_step1" },
  { img: "/smartscreen-2.png", textKey: "ss_step2" },
] as const;

function SmartScreenGuide({ onClose, downloadUrl }: Props) {
  const { t } = useTranslation("landing");
  const [page, setPage] = useState(0);

  const current = PAGES[page];
  const isLast = page === PAGES.length - 1;
  const isFirst = page === 0;

  return (
    <div className="ss-overlay" onClick={onClose}>
      <div className="ss-modal" onClick={(e) => e.stopPropagation()}>
        <button className="ss-close" onClick={onClose} aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4L10.6 12l-4.9 4.9a1 1 0 1 0 1.4 1.4L12 13.4l4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4z" />
          </svg>
        </button>

        <div className="ss-header">
          <h2 className="ss-title">{t("ss_title")}</h2>
          <p className="ss-subtitle">{t("ss_subtitle")}</p>
        </div>

        <div className="ss-body">
          <img src={current.img} alt={`Step ${page + 1}`} className="ss-screenshot" />
          <p className="ss-step-text">{t(current.textKey)}</p>
        </div>

        <div className="ss-pagination">
          {PAGES.map((_, i) => (
            <button
              key={i}
              className={`ss-dot${i === page ? " ss-dot--active" : ""}`}
              onClick={() => setPage(i)}
            />
          ))}
        </div>

        <div className="ss-footer">
          {!isFirst ? (
            <button className="ss-btn ss-btn--back" onClick={() => setPage(page - 1)}>
              {t("ss_back")}
            </button>
          ) : (
            <div />
          )}
          {isLast ? (
            <a href={downloadUrl} className="ss-btn ss-btn--download" target="_blank" rel="noopener noreferrer" onClick={onClose}>
              {t("ss_download")}
            </a>
          ) : (
            <button className="ss-btn ss-btn--next" onClick={() => setPage(page + 1)}>
              {t("ss_next")}
            </button>
          )}
        </div>

        <p className="ss-github-note">
          {t("ss_github_note")}{" "}
          <a href="https://github.com/akinalpfdn/Mqvi" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </p>
      </div>
    </div>
  );
}

export default SmartScreenGuide;
