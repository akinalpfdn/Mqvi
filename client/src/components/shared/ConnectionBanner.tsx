/** ConnectionBanner — WebSocket connection status indicator (connecting/disconnected). */

import { useTranslation } from "react-i18next";

/** Must match MAX_RECONNECT_ATTEMPTS in useWebSocket */
const MAX_RECONNECT_ATTEMPTS = 5;

type ConnectionBannerProps = {
  status: "connected" | "connecting" | "disconnected";
  /** Current reconnect attempt (0 = initial connect or connected) */
  reconnectAttempt: number;
};

function ConnectionBanner({ status, reconnectAttempt }: ConnectionBannerProps) {
  const { t } = useTranslation("common");

  if (status === "connected") return null;

  function handleRefresh() {
    window.location.reload();
  }

  /** Banner text with retry count or disconnected message */
  function getBannerText(): string {
    if (status === "disconnected") {
      return t("connectionFailed");
    }
    // connecting — initial attempt (0) or retry
    if (reconnectAttempt > 0) {
      return t("connectionRetrying", { attempt: reconnectAttempt, max: MAX_RECONNECT_ATTEMPTS });
    }
    return t("connectionConnecting");
  }

  return (
    <div className={`connection-banner ${status}`}>
      <span className="connection-banner-text">
        {getBannerText()}
      </span>
      <button className="connection-banner-btn" onClick={handleRefresh}>
        {t("connectionRefresh")}
      </button>
    </div>
  );
}

export default ConnectionBanner;
