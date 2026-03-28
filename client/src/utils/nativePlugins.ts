/**
 * Capacitor native plugin wrappers.
 * These plugins are no-ops on web/Electron — only active on iOS/Android.
 */

import { registerPlugin } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";
import { Keyboard, KeyboardResize } from "@capacitor/keyboard";
import { isCapacitor } from "./constants";

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
