/** ConnectingScreen — a session is stored but the server cannot be reached yet. i18n: "auth" namespace. */

import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useBootRetry } from "../../hooks/useBootRetry";
import { publicAsset } from "../../utils/constants";

function ConnectingScreen() {
  const { t } = useTranslation("auth");
  const initialize = useAuthStore((s) => s.initialize);
  const abandonSession = useAuthStore((s) => s.abandonSession);
  const { secondsLeft, isRetrying, retryNow } = useBootRetry(initialize);

  return (
    <div className="app-loading app-connecting">
      <img src={publicAsset("mqvi-icon-128.png")} alt="" className="app-loading-logo" />
      <h1 className="app-connecting-title">{t("connectingTitle")}</h1>
      <p className="app-connecting-text">{t("connectingDescription")}</p>
      <p className="app-connecting-status" aria-live="polite">
        {isRetrying ? t("connectingRetrying") : t("connectingRetryIn", { seconds: secondsLeft })}
      </p>
      <div className="app-connecting-actions">
        <button type="button" className="auth-btn" onClick={retryNow} disabled={isRetrying}>
          {t("connectingRetryNow")}
        </button>
        <button type="button" className="app-connecting-logout" onClick={abandonSession}>
          {t("connectingLogout")}
        </button>
      </div>
    </div>
  );
}

export default ConnectingScreen;
