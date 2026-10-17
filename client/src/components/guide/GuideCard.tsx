/** GuideCard — one onboarding step in the guide conversation: open with "Show me", or done. */

import { useTranslation } from "react-i18next";

import type { GuideStepId } from "../../types";
import { detectOS } from "../../utils/detectOS";

type GuideCardProps = {
  step: GuideStepId;
  done: boolean;
  onShowMe: (step: GuideStepId) => void;
};

function GuideCard({ step, done, onShowMe }: GuideCardProps) {
  const { t } = useTranslation("guide");

  return (
    <div className={`guide-card${done ? " done" : ""}`}>
      <div className="guide-card-title">{t(`${step}.title`)}</div>
      <div className="guide-card-desc">{t(`${step}.desc`)}</div>
      {done ? (
        <div className="guide-card-done">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          <span>{t(`${step}.done`)}</span>
        </div>
      ) : step === "app" ? (
        // The user downloads it themselves: the button is the download link.
        <a className="guide-card-btn" href={detectOS().url} target="_blank" rel="noopener noreferrer">
          {t(`landing:${detectOS().i18nKey}`)}
        </a>
      ) : (
        <button type="button" className="guide-card-btn" onClick={() => onShowMe(step)}>
          {t("showMe")}
        </button>
      )}
    </div>
  );
}

export default GuideCard;
