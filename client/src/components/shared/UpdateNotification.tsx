/**
 * UpdateNotification — Auto-update banner.
 *
 * Güncelleme mevcut olduğunda ekranın üstünde sabit banner gösterir.
 * İndirme sırasında progress bar gösterir.
 * Sadece Electron modda render edilir (hook isElectron guard'ı var).
 *
 * CSS: Tema token'ları kullanır (globals.css @theme).
 */

import { useTranslation } from "react-i18next";
import type { FC } from "react";

type Props = {
  status: "available" | "downloading" | "installing" | "error";
  version: string;
  progress: number;
  error: string | null;
  onInstall: () => void;
  onDismiss: () => void;
};

const UpdateNotification: FC<Props> = ({
  status,
  version,
  progress,
  error,
  onInstall,
  onDismiss,
}) => {
  const { t } = useTranslation("settings");

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: "10px 16px",
        background: "var(--primary)",
        color: "#fff",
        fontSize: 14,
        fontFamily: "var(--f-s)",
      }}
    >
      {status === "available" && (
        <>
          <span>{t("updateVersion", { version })}</span>
          <button
            onClick={onInstall}
            style={{
              padding: "4px 14px",
              borderRadius: 4,
              border: "1px solid rgba(255,255,255,0.3)",
              background: "rgba(255,255,255,0.15)",
              color: "#fff",
              fontSize: 13,
              cursor: "pointer",
              fontFamily: "var(--f-s)",
            }}
          >
            {t("updateNow")}
          </button>
          <button
            onClick={onDismiss}
            style={{
              padding: "4px 10px",
              borderRadius: 4,
              border: "none",
              background: "transparent",
              color: "rgba(255,255,255,0.7)",
              fontSize: 13,
              cursor: "pointer",
              fontFamily: "var(--f-s)",
            }}
          >
            {t("updateLater")}
          </button>
        </>
      )}

      {status === "downloading" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", maxWidth: 400 }}>
          <span>{t("updateDownloading")}</span>
          <div
            style={{
              flex: 1,
              height: 6,
              borderRadius: 3,
              background: "rgba(255,255,255,0.2)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                borderRadius: 3,
                background: "#fff",
                transition: "width 0.2s ease",
              }}
            />
          </div>
          <span style={{ fontSize: 12, minWidth: 36, textAlign: "right" }}>
            {progress}%
          </span>
        </div>
      )}

      {status === "installing" && (
        <span>{t("updateInstalling")}</span>
      )}

      {status === "error" && (
        <>
          <span>{t("updateError")}: {error}</span>
          <button
            onClick={onDismiss}
            style={{
              padding: "4px 10px",
              borderRadius: 4,
              border: "none",
              background: "rgba(255,255,255,0.15)",
              color: "#fff",
              fontSize: 13,
              cursor: "pointer",
              fontFamily: "var(--f-s)",
            }}
          >
            OK
          </button>
        </>
      )}
    </div>
  );
};

export default UpdateNotification;
