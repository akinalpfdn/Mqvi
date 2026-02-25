/**
 * useUpdateChecker — Electron auto-update hook.
 *
 * Uygulama mount olduğunda arka planda güncelleme kontrolü yapar.
 * Güncelleme varsa state'e kaydeder, UI bunu gösterir.
 * Web modda (isElectron() === false) hiçbir şey yapmaz.
 *
 * Electron'un electron-updater kütüphanesini kullanır:
 * - Main process'te autoUpdater güncelleme kontrol eder
 * - IPC üzerinden renderer'a event gönderir
 * - Renderer preload API ile güncelleme indirir/kurar
 *
 * Tauri'den geçiş: @tauri-apps/plugin-updater → electron-updater IPC bridge
 */

import { useState, useEffect, useCallback } from "react";
import { isElectron } from "../utils/constants";

/** Güncelleme durumu */
type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error";

/** Güncelleme bilgisi */
type UpdateInfo = {
  version: string;
  notes: string;
};

/** Hook return tipi */
type UpdateChecker = {
  status: UpdateStatus;
  update: UpdateInfo | null;
  progress: number;
  error: string | null;
  installUpdate: () => Promise<void>;
  dismiss: () => void;
};

export function useUpdateChecker(): UpdateChecker {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // ─── Event listener'ları kur ve güncelleme kontrolü yap ───
  useEffect(() => {
    if (!isElectron()) return;

    const api = window.electronAPI!;

    // Main process'ten gelen güncelleme event'lerini dinle
    api.onUpdateAvailable((info) => {
      setUpdate({
        version: info.version,
        notes: info.releaseNotes ?? "",
      });
      setStatus("available");
    });

    api.onUpdateProgress((progressInfo) => {
      setStatus("downloading");
      setProgress(Math.round(progressInfo.percent));
    });

    api.onUpdateDownloaded(() => {
      setProgress(100);
      setStatus("installing");
    });

    api.onUpdateError(() => {
      // Güncelleme hatası — banner gösterme, sessizce idle'a dön.
      // Kullanıcı manual kontrol ederse installUpdate catch'inde hata gösterilir.
      setStatus("idle");
    });

    // 3 saniye bekle — uygulamanın tam yüklenmesini bekle, sonra güncelleme kontrolü
    const timer = setTimeout(async () => {
      setStatus("checking");
      try {
        const result = await api.checkUpdate();
        if (result) {
          setUpdate({
            version: result.version,
            notes: result.releaseNotes ?? "",
          });
          setStatus("available");
        } else {
          setStatus("idle");
        }
      } catch {
        // GitHub'da release asset yoksa veya ağ hatası olursa sessizce geç.
        // Güncelleme kontrolü başarısız olması uygulamayı etkilemez.
        setStatus("idle");
      }
    }, 3000);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  // Güncellemeyi indir ve kur
  const installUpdate = useCallback(async () => {
    if (!isElectron()) return;

    const api = window.electronAPI!;

    try {
      setStatus("downloading");
      setProgress(0);

      // İndirme başlat — progress event'leri onUpdateProgress callback'i ile gelir
      const success = await api.downloadUpdate();

      if (success) {
        // İndirme tamamlandı — kurulumu başlat ve uygulamayı yeniden başlat
        setStatus("installing");
        await api.installUpdate();
      } else {
        setError("Download failed");
        setStatus("error");
      }
    } catch (err) {
      console.error("[updater] install failed:", err);
      setError(err instanceof Error ? err.message : "Update failed");
      setStatus("error");
    }
  }, []);

  // Bildirimi kapat
  const dismiss = useCallback(() => {
    setStatus("idle");
    setUpdate(null);
  }, []);

  return { status, update, progress, error, installUpdate, dismiss };
}
