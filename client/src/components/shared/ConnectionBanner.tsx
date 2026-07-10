/** ConnectionBanner — WebSocket connection status indicator (connecting/disconnected). */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { WS_MAX_RECONNECT_ATTEMPTS } from "../../utils/constants";

/**
 * Grace period before the banner appears (ms). A cold start, a radio blip, or the
 * reconnect that follows unlocking the phone all finish inside this window — telling
 * the user about a five-second reconnect is noise, not information.
 */
const BANNER_GRACE = 7_000;

type ConnectionBannerProps = {
  status: "connected" | "connecting" | "disconnected";
  /** Current reconnect attempt (0 = initial connect or connected) */
  reconnectAttempt: number;
};

function ConnectionBanner({ status, reconnectAttempt }: ConnectionBannerProps) {
  const { t } = useTranslation("common");
  const [isVisible, setIsVisible] = useState(false);

  const isOffline = status !== "connected";

  // Keyed on isOffline, not status: a connecting → disconnected transition must not
  // restart the grace timer and blank an already-visible banner.
  useEffect(() => {
    if (!isOffline) {
      setIsVisible(false);
      return;
    }
    const timer = setTimeout(() => setIsVisible(true), BANNER_GRACE);
    return () => clearTimeout(timer);
  }, [isOffline]);

  if (!isOffline || !isVisible) return null;

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
      return t("connectionRetrying", { attempt: reconnectAttempt, max: WS_MAX_RECONNECT_ATTEMPTS });
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
