/** ConnectingScreen — a session is stored but the server cannot be reached yet. i18n: "auth" namespace. */

import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useBootRetry } from "../../hooks/useBootRetry";
import { publicAsset } from "../../utils/constants";

function ConnectingScreen() {
  const { t } = useTranslation("auth");
  const initialize = useAuthStore((s) => s.initialize);
  const abandonSession = useAuthStore((s) => s.abandonSession);
  useBootRetry(initialize);

  return (
    <div className="app-loading app-connecting">
      <img src={publicAsset("mqvi-icon-128.png")} alt="" className="app-loading-logo" />
      <p className="app-connecting-text" aria-live="polite">{t("connectingMessage")}</p>
      <div className="app-loading-spinner" />
      <button type="button" className="app-connecting-logout" onClick={abandonSession}>
        {t("connectingLogout")}
      </button>
    </div>
  );
}

export default ConnectingScreen;
