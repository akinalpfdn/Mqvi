/**
 * Capacitor native plugin wrappers.
 * These plugins are no-ops on web/Electron — only active on iOS/Android.
 */

import { registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { StatusBar, Style } from "@capacitor/status-bar";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { isCapacitor, getCapacitorPlatform } from "./constants";
import { ensureFreshToken } from "../api/client";

// ─── VoiceCallService Plugin ───

interface VoiceCallServicePlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const VoiceCallService = registerPlugin<VoiceCallServicePlugin>("VoiceCallService");

/**
 * Start the native foreground service for background audio.
 * - Android: starts a foreground service with persistent notification.
 * - iOS: no-op (AVAudioSession + background modes handle this).
 * - Web/Electron: no-op.
 */
export async function startVoiceCallService(): Promise<void> {
  if (!isCapacitor()) return;
  await VoiceCallService.start();
}

/**
 * Stop the native foreground service.
 * Called when the user leaves a voice channel.
 */
export async function stopVoiceCallService(): Promise<void> {
  if (!isCapacitor()) return;
  await VoiceCallService.stop();
}

// ─── App Lifecycle ───

/**
 * Custom event dispatched when the app returns from background.
 * useWebSocket listens for this to trigger reconnect if needed.
 */
export const APP_RESUME_EVENT = "mqvi:app-resume";

/**
 * Initialize app lifecycle listeners for Capacitor (iOS/Android).
 * - On resume: refresh auth token + dispatch resume event for WS reconnect
 * - On Android: handle hardware back button
 *
 * Called once on app startup.
 */
export async function initAppLifecycle(): Promise<void> {
  if (!isCapacitor()) return;

  // Foreground/background state changes
  await App.addListener("appStateChange", async ({ isActive }) => {
    if (!isActive) return;

    // App returned to foreground — refresh token and notify WS
    try {
      await ensureFreshToken();
    } catch {
      // Token refresh may fail if server is unreachable — WS reconnect will handle it
    }

    window.dispatchEvent(new CustomEvent(APP_RESUME_EVENT));
  });

  // Android hardware back button
  if (getCapacitorPlatform() === "android") {
    await App.addListener("backButton", ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
      } else {
        App.minimizeApp();
      }
    });
  }
}

// ─── Screen Share Plugin (iOS only) ───

interface ScreenSharePluginInterface {
  start(opts: { url: string; token: string }): Promise<{ started: boolean }>;
  stop(): Promise<{ stopped: boolean }>;
  isActive(): Promise<{ active: boolean }>;
  addListener(event: "screenShareStopped", handler: () => void): Promise<{ remove: () => void }>;
}

const ScreenShareNative = registerPlugin<ScreenSharePluginInterface>("ScreenShare");

/**
 * Start iOS native screen share via ReplayKit + LiveKit Swift SDK.
 * Connects to the LiveKit room as a separate "{userId}_ss" identity
 * and triggers the system broadcast picker for full-screen capture.
 *
 * No-op on non-iOS platforms — Android uses getDisplayMedia, Electron uses WASAPI.
 */
export async function startNativeScreenShare(url: string, token: string): Promise<boolean> {
  if (!isCapacitor() || getCapacitorPlatform() !== "ios") return false;
  const result = await ScreenShareNative.start({ url, token });
  return result.started;
}

/**
 * Stop iOS native screen share and disconnect the native LiveKit room.
 */
export async function stopNativeScreenShare(): Promise<void> {
  if (!isCapacitor() || getCapacitorPlatform() !== "ios") return;
  await ScreenShareNative.stop();
}

/**
 * Check if native screen share is currently active.
 */
export async function isNativeScreenShareActive(): Promise<boolean> {
  if (!isCapacitor() || getCapacitorPlatform() !== "ios") return false;
  const result = await ScreenShareNative.isActive();
  return result.active;
}

/**
 * Listen for native screen share stopped (e.g., user stops from Control Center).
 * Returns a cleanup function to remove the listener.
 */
export async function onNativeScreenShareStopped(handler: () => void): Promise<() => void> {
  if (!isCapacitor() || getCapacitorPlatform() !== "ios") return () => {};
  const listener = await ScreenShareNative.addListener("screenShareStopped", handler);
  return () => listener.remove();
}

// ─── Status Bar & Keyboard ───

/**
 * Configure status bar and keyboard behavior for mobile.
 * Called once on app startup.
 */
export async function configureMobileUI(): Promise<void> {
  if (!isCapacitor()) return;

  try {
    // Dark status bar to match app theme
    await StatusBar.setStyle({ style: Style.Dark });
    // Transparent overlay — content extends behind status bar (safe area CSS handles spacing)
    await StatusBar.setOverlaysWebView({ overlay: true });
  } catch {
    // StatusBar plugin may not be available on all platforms
  }

  try {
    // Keyboard resizes the body (not the native WebView) for better control
    await Keyboard.setResizeMode({ mode: KeyboardResize.Body });
    // Auto-scroll to focused input when keyboard opens
    await Keyboard.setScroll({ isDisabled: false });
  } catch {
    // Keyboard plugin may not be available on all platforms
  }
}
