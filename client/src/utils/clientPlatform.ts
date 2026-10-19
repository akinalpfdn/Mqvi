/**
 * How this client describes itself to the server, for the active-devices screen. Sent as headers on
 * every request; the server stores them with the session at sign-in and refresh.
 *
 * The label is a key the devices screen translates ("desktop", "mobile") or, on the web, the
 * browser's name. ASCII only — header values cannot carry anything else.
 */

import { isCapacitor, isElectron, getCapacitorPlatform } from "./constants";

export type ClientPlatform = "windows" | "macos" | "linux" | "android" | "ios" | "web";

const ELECTRON_PLATFORMS: Record<string, ClientPlatform> = {
  win32: "windows",
  darwin: "macos",
  linux: "linux",
};

export function clientPlatform(): ClientPlatform {
  if (isElectron()) {
    return ELECTRON_PLATFORMS[window.electronAPI?.platform ?? ""] ?? "web";
  }
  if (isCapacitor()) {
    const platform = getCapacitorPlatform();
    if (platform === "android" || platform === "ios") return platform;
  }
  return "web";
}

/** Order matters: Edge and Opera carry "Chrome" in their user agent too. */
const BROWSERS: [RegExp, string][] = [
  [/Edg\//, "Edge"],
  [/OPR\//, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

export function clientDeviceLabel(userAgent: string = navigator.userAgent): string {
  if (isElectron()) return "desktop";
  if (isCapacitor()) return "mobile";
  return BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "browser";
}

export function clientHeaders(): Record<string, string> {
  return {
    "X-Client-Platform": clientPlatform(),
    "X-Client-Device": clientDeviceLabel(),
  };
}
