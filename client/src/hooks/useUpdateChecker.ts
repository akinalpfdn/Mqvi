/**
 * useUpdateChecker — Tauri auto-update hook.
 *
 * Uygulama mount olduğunda arka planda güncelleme kontrolü yapar.
 * Güncelleme varsa state'e kaydeder, UI bunu gösterir.
 * Web modda (isTauri() === false) hiçbir şey yapmaz.
 *
 * Tauri v2 updater plugin kullanır:
 * - check(): GitHub Releases endpoint'inden latest.json çeker
 * - downloadAndInstall(): İmzalı güncellemeyi indirir, doğrular, kurar
 * - relaunch(): Uygulamayı yeni sürümle yeniden başlatır
 */

import { useState, useEffect, useCallback } from "react";
import { isTauri } from "../utils/constants";

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

/**
 * Tauri plugin'lerini dinamik import eder.
 * Web modda bu modüller mevcut olmaz — catch ile güvenli.
 */
async function getTauriPlugins() {
  const [updater, process] = await Promise.all([
    import("@tauri-apps/plugin-updater"),
    import("@tauri-apps/plugin-process"),
  ]);
  return { check: updater.check, relaunch: process.relaunch };
}

export function useUpdateChecker(): UpdateChecker {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Uygulama başladığında güncelleme kontrolü
  useEffect(() => {
    if (!isTauri()) return;

    let cancelled = false;

    async function checkForUpdate() {
      setStatus("checking");

      try {
        const { check } = await getTauriPlugins();
        const result = await check();

        if (cancelled) return;

        if (result) {
          setUpdate({
            version: result.version,
            notes: result.body ?? "",
          });
          setStatus("available");
        } else {
          setStatus("idle");
        }
      } catch (err) {
        if (cancelled) return;
        console.error("[updater] check failed:", err);
        setError(err instanceof Error ? err.message : "Update check failed");
        setStatus("error");
      }
    }

    // 3 saniye bekle — uygulamanın tam yüklenmesini bekle
    const timer = setTimeout(checkForUpdate, 3000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Güncellemeyi indir ve kur
  const installUpdate = useCallback(async () => {
    if (!isTauri()) return;

    try {
      const { check, relaunch } = await getTauriPlugins();
      const result = await check();

      if (!result) return;

      setStatus("downloading");
      setProgress(0);

      let totalBytes = 0;
      let downloadedBytes = 0;

      await result.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            totalBytes = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloadedBytes += event.data.chunkLength;
            if (totalBytes > 0) {
              setProgress(Math.round((downloadedBytes / totalBytes) * 100));
            }
            break;
          case "Finished":
            setProgress(100);
            setStatus("installing");
            break;
        }
      });

      // Uygulamayı yeniden başlat
      await relaunch();
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
