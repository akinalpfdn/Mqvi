/**
 * Feeds appFocusStore. Called once at startup, on every platform.
 *
 * Web and Electron: visibility + document.hasFocus(), which is accurate there.
 * Capacitor: visibility + the native app state. NOT hasFocus() — an Android WebView can report it
 * false while the app is in front, and the DM read loop would then never mark the conversation on
 * screen as read, so the phone would keep buzzing for it.
 */

import { App } from "@capacitor/app";
import { isCapacitor } from "./constants";
import { useAppFocusStore } from "../stores/appFocusStore";

/** Returns a dispose function. State lives in the closure, not the module. */
export function initAppFocus(): () => void {
  let nativeActive: boolean | null = null;
  // The native state could not be read. Fall back to the web signal rather than sit at "unknown"
  // forever, which would mean nothing is ever marked read.
  let nativeUnavailable = false;
  let disposed = false;
  let removeNative: (() => void) | undefined;

  const recompute = () => {
    if (disposed) return;

    let value: boolean | null;
    if (!isCapacitor() || nativeUnavailable) {
      value = document.visibilityState === "visible" && document.hasFocus();
    } else if (nativeActive === null) {
      value = null; // App.getState() has not answered yet
    } else {
      // The native app state ALONE. Not document.visibilityState: an Android WebView does not
      // reliably restore it (or fire visibilitychange) when the app is resumed, so after one
      // background/resume cycle the app looked permanently backgrounded — the DM on screen was
      // never marked read, its badge never cleared, and its notification stayed on the tray.
      // Observed on device. Neither DOM signal means anything here; the app state is authoritative.
      value = nativeActive;
    }

    if (useAppFocusStore.getState().isForeground !== value) {
      useAppFocusStore.getState().setForeground(value);
    }
  };

  window.addEventListener("focus", recompute);
  window.addEventListener("blur", recompute);
  document.addEventListener("visibilitychange", recompute);

  if (isCapacitor()) {
    App.getState()
      .then((state) => {
        nativeActive = state.isActive;
      })
      .catch(() => {
        nativeUnavailable = true;
      })
      .finally(recompute);

    void App.addListener("appStateChange", ({ isActive }) => {
      nativeActive = isActive;
      recompute();
    }).then((handle) => {
      if (disposed) {
        void handle.remove();
        return;
      }
      removeNative = () => void handle.remove();
    });
  }

  recompute();

  return () => {
    disposed = true;
    window.removeEventListener("focus", recompute);
    window.removeEventListener("blur", recompute);
    document.removeEventListener("visibilitychange", recompute);
    removeNative?.();
  };
}
