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

// ─── Screen Share Plugin (iOS + Android) ───

interface ScreenSharePluginInterface {
  start(opts: { url: string; token: string }): Promise<{ started: boolean }>;
  stop(): Promise<{ stopped: boolean }>;
  isActive(): Promise<{ active: boolean }>;
  addListener(event: "screenShareStopped", handler: () => void): Promise<{ remove: () => void }>;
}

const ScreenShareNative = registerPlugin<ScreenSharePluginInterface>("ScreenShare");

/**
 * Start native screen share via platform-specific API + LiveKit native SDK.
 * iOS: ReplayKit + LiveKit Swift SDK.
 * Android: MediaProjection + LiveKit Android SDK.
 * Both connect as a separate LiveKit room identity ("{userId}_ss").
 */
export async function startNativeScreenShare(url: string, token: string): Promise<boolean> {
  if (!isCapacitor()) return false;
  const result = await ScreenShareNative.start({ url, token });
  return result.started;
}

/**
 * Stop native screen share and disconnect the native LiveKit room.
 */
export async function stopNativeScreenShare(): Promise<void> {
  if (!isCapacitor()) return;
  await ScreenShareNative.stop();
}

/**
 * Check if native screen share is currently active.
 */
export async function isNativeScreenShareActive(): Promise<boolean> {
  if (!isCapacitor()) return false;
  const result = await ScreenShareNative.isActive();
  return result.active;
}

/**
 * Listen for native screen share stopped externally.
 * iOS: user stops from Control Center. Android: system revokes MediaProjection.
 * Returns a cleanup function to remove the listener.
 */
export async function onNativeScreenShareStopped(handler: () => void): Promise<() => void> {
  if (!isCapacitor()) return () => {};
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
    // Dark status bar (light icons) to match app's dark theme
    await StatusBar.setStyle({ style: Style.Dark });
    // Dark background color matching the app theme
    await StatusBar.setBackgroundColor({ color: "#111111" });
    // No overlay — system reserves space for status bar, content starts below it
    await StatusBar.setOverlaysWebView({ overlay: false });
  } catch {
    // StatusBar plugin may not be available on all platforms
  }

  try {
    // None — let the WebView handle keyboard resize natively.
    // Body/Ionic modes cause double-shift with safe-area padding.
    await Keyboard.setResizeMode({ mode: KeyboardResize.None });
    await Keyboard.setScroll({ isDisabled: false });
  } catch {
    // Keyboard plugin may not be available on all platforms
  }
}
