/** MobileUpdatePrompt — "update the app" on iOS and Android: dismissible, or blocking when required. */

import { useTranslation } from "react-i18next";
import { useMobileUpdate } from "../../hooks/useMobileUpdate";

function MobileUpdatePrompt() {
  const { t } = useTranslation("common");
  const { state, update, dismiss } = useMobileUpdate();

  if (state.kind === "none") return null;
  const required = state.kind === "required";

  return (
    <div
      className={`download-prompt-overlay${required ? " update-required" : ""}`}
      onClick={required ? undefined : dismiss}
      role="dialog"
      aria-modal="true"
    >
      <div className="download-prompt-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t(required ? "updateRequiredTitle" : "updateAvailableTitle")}</h3>
        <p>{t(required ? "updateRequiredDesc" : "updateAvailableDesc")}</p>
        <div className="download-prompt-actions">
          <button className="download-prompt-btn-primary" onClick={() => void update()}>
            {t("updateNow")}
          </button>
          {!required && (
            <button className="download-prompt-btn-dismiss" onClick={dismiss}>
              {t("updateLater")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default MobileUpdatePrompt;
