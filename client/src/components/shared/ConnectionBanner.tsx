/**
 * ConnectionBanner — WebSocket bağlantı durumu göstergesi.
 *
 * Bağlantı koptuğunda (server restart, ağ kesintisi) ekranın üstünde
 * sabit bir banner gösterir. Kullanıcıya ne olduğunu anlatır ve
 * "Yenile" butonu ile uygulamayı yeniden yükleyebilir.
 *
 * Durumlar:
 * - "connected": Banner gösterilmez
 * - "connecting": Sarı banner — "Sunucuya bağlanılıyor..."
 * - "disconnected": Kırmızı banner — "Bağlantı koptu" + Yenile butonu
 */

import { useTranslation } from "react-i18next";

type ConnectionBannerProps = {
  status: "connected" | "connecting" | "disconnected";
};

function ConnectionBanner({ status }: ConnectionBannerProps) {
  const { t } = useTranslation("common");

  if (status === "connected") return null;

  function handleRefresh() {
    window.location.reload();
  }

  return (
    <div className={`connection-banner ${status}`}>
      <span className="connection-banner-text">
        {status === "connecting" ? t("connectionConnecting") : t("connectionLost")}
      </span>
      {status === "disconnected" && (
        <button className="connection-banner-btn" onClick={handleRefresh}>
          {t("connectionRefresh")}
        </button>
      )}
    </div>
  );
}

export default ConnectionBanner;
