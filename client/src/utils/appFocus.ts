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

  // ASK, never listen to the payload. On Android the WebView suspends JS while the app is in the
  // background, so the isActive:false that BridgeActivity fires from onStop() is queued and only
  // delivered on RESUME — arriving alongside, and sometimes AFTER, the isActive:true from
  // onResume(). Taking the event at its word leaves nativeActive stuck at false while the app is
  // in front, and the DM on screen is never marked read.
  // (ionic-team/capacitor-plugins#479. BridgeActivity.onResume/onStop set App.isActive in Java,
  // synchronously; App.getState() reads that field, so it is correct no matter when — or in what
  // order — the events reach JS.)
  const refreshNativeState = async () => {
    try {
      const state = await App.getState();
      nativeActive = state.isActive;
    } catch {
      // Without this the store would sit at "unknown" forever and nothing would be marked read.
      nativeUnavailable = true;
    }
    recompute();
  };

  if (isCapacitor()) {
    void refreshNativeState();

    const handles: Promise<{ remove: () => Promise<void> }>[] = [
      App.addListener("appStateChange", () => void refreshNativeState()),
      // onPause: the app is losing the foreground. App.isActive is not false until onStop, so ask
      // nothing here — a dialog, a picker or an incoming-call screen on top all mean the user is
      // not reading the conversation.
      App.addListener("pause", () => {
        nativeActive = false;
        recompute();
      }),
      App.addListener("resume", () => void refreshNativeState()),
    ];

    void Promise.all(handles).then((hs) => {
      if (disposed) {
        hs.forEach((h) => void h.remove());
        return;
      }
      removeNative = () => hs.forEach((h) => void h.remove());
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
