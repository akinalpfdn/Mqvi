import { isNativeApp } from "./constants";

const RELEASE_BASE = "https://github.com/akinalpfdn/Mqvi/releases/latest/download";
const RELEASES_PAGE = "https://github.com/akinalpfdn/Mqvi/releases/latest";
export const APP_STORE_URL = "https://apps.apple.com/us/app/mqvi-voice-chat-communities/id6761312531";
export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.akinalpfdn.mqvi";

export type OSInfo = {
  os: "windows" | "macos" | "linux" | "ios" | "android" | "mobile";
  url: string;
  i18nKey: string;
};

export function detectOS(): OSInfo {
  const ua = navigator.userAgent.toLowerCase();
  // iPadOS asks for desktop sites and reports a Mac; only its touch points give it away.
  if (/iphone|ipad|ipod/.test(ua) || (ua.includes("mac") && navigator.maxTouchPoints > 1)) {
    return { os: "ios", url: APP_STORE_URL, i18nKey: "hero_download_ios" };
  }
  if (ua.includes("android")) {
    return { os: "android", url: PLAY_STORE_URL, i18nKey: "hero_download_android" };
  }
  if (/mobile/.test(ua)) {
    return { os: "mobile", url: RELEASES_PAGE, i18nKey: "hero_download_desktop" };
  }
  if (ua.includes("mac")) {
    return { os: "macos", url: `${RELEASE_BASE}/mqvi-setup.dmg`, i18nKey: "hero_download_macos" };
  }
  if (ua.includes("linux")) {
    return { os: "linux", url: `${RELEASE_BASE}/mqvi-setup.AppImage`, i18nKey: "hero_download_linux" };
  }
  return { os: "windows", url: `${RELEASE_BASE}/mqvi-setup.exe`, i18nKey: "hero_download_windows" };
}

/** Returns true if running on desktop OS in a web browser (not Electron/Capacitor, not mobile) */
export function shouldShowDownloadPrompt(): boolean {
  if (isNativeApp()) return false;
  const { os } = detectOS();
  return os === "windows" || os === "macos" || os === "linux";
}

/** The one-time "get the desktop app" prompt is waiting for this user (web, desktop OS). */
export function isDownloadPromptPending(user: { has_seen_download_prompt: boolean } | null): boolean {
  return !!user && !user.has_seen_download_prompt && shouldShowDownloadPrompt();
}
