/**
 * ConnectionBanner — WebSocket bağlantı durumu göstergesi.
 *
 * Bağlantı koptuğunda (server restart, ağ kesintisi) ekranın üstünde
 * sabit bir banner gösterir. Kullanıcıya ne olduğunu anlatır ve
 * "Yenile" butonu ile uygulamayı yeniden yükleyebilir.
 *
 * Durumlar:
 * - "connected": Banner gösterilmez
 * - "connecting": Sarı banner — "Sunucuya bağlanılıyor... (deneme 2/5)"
 * - "disconnected": Kırmızı banner — "Sunucuya bağlanılamadı" + Yenile butonu
 */

import { useTranslation } from "react-i18next";

/** Maksimum reconnect deneme sayısı — useWebSocket'teki ile senkron */
const MAX_RECONNECT_ATTEMPTS = 5;

type ConnectionBannerProps = {
  status: "connected" | "connecting" | "disconnected";
  /** Kaçıncı reconnect denemesinde olduğumuz (0 = ilk bağlantı veya bağlı) */
  reconnectAttempt: number;
};

function ConnectionBanner({ status, reconnectAttempt }: ConnectionBannerProps) {
  const { t } = useTranslation("common");

  if (status === "connected") return null;

  function handleRefresh() {
    window.location.reload();
  }

  /** Banner metni: retry sırasında deneme sayısı göster, disconnected'da "bağlanılamadı" */
  function getBannerText(): string {
    if (status === "disconnected") {
      return t("connectionFailed");
    }
    // connecting — ilk bağlantı denemesi (attempt=0) veya retry
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
