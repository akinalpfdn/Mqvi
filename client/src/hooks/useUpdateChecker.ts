/**
 * useUpdateChecker — Electron auto-update hook.
 *
 * Discord modeli:
 * 1. Splash screen'de güncelleme kontrolü yapılır (main process)
 * 2. Splash'te güncelleme yoksa → uygulama açılır, renderer tekrar kontrol etmez
 * 3. Runtime'da güncelleme bulunursa → arka planda otomatik indirilir
 * 4. İndirme bitince → "Yeniden başlat" banner'ı gösterilir
 * 5. Kullanıcı tıklarsa hemen restart, tıklamazsa app kapanırken kurulur
 *
 * Web modda (isElectron() === false) hiçbir şey yapmaz.
 */

import { useState, useEffect, useCallback } from "react";
import { isElectron } from "../utils/constants";

/** Güncelleme durumu */
type UpdateStatus =
  | "idle"
  | "downloading"
  | "ready"
  | "error";

/** Güncelleme bilgisi */
type UpdateInfo = {
  version: string;
};

/** Hook return tipi */
type UpdateChecker = {
  status: UpdateStatus;
  update: UpdateInfo | null;
  progress: number;
  error: string | null;
  restartAndInstall: () => void;
  dismiss: () => void;
};

export function useUpdateChecker(): UpdateChecker {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isElectron()) return;

    const api = window.electronAPI!;

    // Main process'ten gelen güncelleme event'lerini dinle.
    // autoDownload=true olduğu için update-available geldiğinde
    // indirme otomatik başlar — banner sadece progress gösterir.
    api.onUpdateAvailable((info) => {
      setUpdate({ version: info.version });
      setStatus("downloading");
      setProgress(0);
    });

    api.onUpdateProgress((progressInfo) => {
      setProgress(Math.round(progressInfo.percent));
    });

    api.onUpdateDownloaded(() => {
      setProgress(100);
      // İndirme bitti — "Yeniden başlat" banner'ı göster
      setStatus("ready");
    });

    api.onUpdateError(() => {
      // Güncelleme hatası — sessizce idle'a dön
      setStatus("idle");
    });

    // Cleanup yok — listener'lar app ömrü boyunca kalır
  }, []);

  // Kullanıcı "Yeniden Başlat" tıklarsa → hemen kur ve restart
  const restartAndInstall = useCallback(() => {
    if (!isElectron()) return;
    window.electronAPI!.installUpdate();
  }, []);

  // Banner'ı kapat — app kapanırken otomatik kurulur (autoInstallOnAppQuit)
  const dismiss = useCallback(() => {
    setStatus("idle");
    setUpdate(null);
  }, []);

  return { status, update, progress, error, restartAndInstall, dismiss };
}
