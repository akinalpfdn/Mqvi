/** MobileUpdatePrompt — "update the app" on iOS and Android: dismissible, or blocking when required. */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useBackHandler } from "../../hooks/useBackHandler";
import { useMobileUpdate } from "../../hooks/useMobileUpdate";
import { useAppUpdateStore } from "../../stores/appUpdateStore";
import { BackPriority } from "../../utils/backStack";

function MobileUpdatePrompt() {
  const { t } = useTranslation("common");
  const { state, update, dismiss } = useMobileUpdate();
  const setPromptVisible = useAppUpdateStore((s) => s.setPromptVisible);

  const visible = state.kind !== "none";
  useEffect(() => {
    setPromptVisible(visible);
  }, [visible, setPromptVisible]);
  // Android back puts the optional prompt off, before anything under it. The required one has no
  // back action: back then does what it would anyway (close what is under it, or leave the app).
  useBackHandler(dismiss, state.kind === "available", BackPriority.Overlay);

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
