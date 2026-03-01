/**
 * UpdateNotification — Auto-update banner (Discord modeli).
 *
 * İki durum gösterir:
 * 1. "downloading": Arka planda indiriliyor — progress bar
 * 2. "ready": İndirme bitti — "Yeniden Başlat" butonu
 *
 * CSS: Tema token'ları kullanır (globals.css @theme).
 */

import { useTranslation } from "react-i18next";
import type { FC } from "react";

type Props = {
  status: "downloading" | "ready" | "error";
  version: string;
  progress: number;
  error: string | null;
  onRestart: () => void;
  onDismiss: () => void;
};

const UpdateNotification: FC<Props> = ({
  status,
  version,
  progress,
  error,
  onRestart,
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
      {status === "downloading" && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", maxWidth: 400 }}>
          <span>{t("updateDownloading", { version })}</span>
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
          <span style={{ fontSize: 13, minWidth: 36, textAlign: "right" }}>
            {progress}%
          </span>
        </div>
      )}

      {status === "ready" && (
        <>
          <span>{t("updateReady", { version })}</span>
          <button
            onClick={onRestart}
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
            {t("updateRestart")}
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
