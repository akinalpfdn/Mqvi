/**
 * CinemaButton — turn the phone sideways and let the stream fill it.
 *
 * Touch only: on a mouse the window is already the right shape and the fullscreen button next
 * to it does the job. Rendered outside the hover overlays the panels use, because a touch
 * device has no hover and a control that only appears on it is a control that does not exist.
 */

import { useTranslation } from "react-i18next";

type CinemaButtonProps = {
  isCinema: boolean;
  onEnter: () => void;
  onExit: () => void;
};

function CinemaButton({ isCinema, onEnter, onExit }: CinemaButtonProps) {
  const { t } = useTranslation("voice");

  return (
    <button
      className={`cinema-btn${isCinema ? " active" : ""}`}
      onClick={(e) => {
        // The panels turn a double-click into fullscreen and a click into focus; neither is
        // what this button means.
        e.stopPropagation();
        if (isCinema) onExit();
        else onEnter();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      title={isCinema ? t("exitCinema") : t("cinema")}
      aria-label={isCinema ? t("exitCinema") : t("cinema")}
    >
      {isCinema ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      ) : (
        // A phone turning on its side.
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x="7" y="2" width="10" height="16" rx="2" />
          <path d="M12 18h.01" />
          <path d="M3 17a9 9 0 0 0 5 4" />
          <polyline points="3 21 3 17 7 17" />
        </svg>
      )}
    </button>
  );
}

export default CinemaButton;
