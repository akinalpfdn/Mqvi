/**
 * useUpdateChecker — Electron auto-update hook.
 *
 * Flow:
 * 1. Update check happens at splash screen (main process)
 * 2. If found at runtime, downloads in background (autoDownload=true)
 * 3. Shows "Restart" banner when download completes
 * 4. User clicks restart or update installs on next app quit
 *
 * No-op in web mode.
 */

import { useState, useEffect, useCallback } from "react";
import { isElectron } from "../utils/constants";

type UpdateStatus =
  | "idle"
  | "downloading"
  | "ready"
  | "error";

type UpdateInfo = {
  version: string;
};

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
      setStatus("ready");
    });

    api.onUpdateError((message) => {
      // Network errors (tunnel failures, no internet) are expected —
      // don't show a banner, just log for debugging
      console.warn("[updater] Update check failed:", message);
    });

    // Listeners persist for app lifetime — no cleanup needed
  }, []);

  const restartAndInstall = useCallback(() => {
    if (!isElectron()) return;
    window.electronAPI!.installUpdate();
  }, []);

  // Dismiss banner — update installs on app quit (autoInstallOnAppQuit)
  const dismiss = useCallback(() => {
    setStatus("idle");
    setUpdate(null);
  }, []);

  return { status, update, progress, error, restartAndInstall, dismiss };
}
