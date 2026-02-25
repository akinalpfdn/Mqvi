/**
 * Application-wide constants.
 * No hardcoded values elsewhere — every constant goes here.
 */

// ─── Electron Detection ───

/**
 * Detects if the app is running inside an Electron desktop shell.
 * Electron preload script injects window.electronAPI via contextBridge.
 *
 * Tauri'den geçiş: eski isTauri() → yeni isElectron()
 * Tauri "__TAURI_INTERNALS__" kullanıyordu, Electron "electronAPI" kullanır.
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.electronAPI;
}

// ─── Server URL Resolution ───

/**
 * Resolves the server base URL based on runtime environment.
 *
 * Web mode: Frontend is served by the Go backend (same-origin),
 *           so "" (empty) lets relative paths like /api/... work naturally.
 *
 * Electron mode: Frontend is served from file:// (local dist),
 *                so we need the absolute server URL (e.g. "https://mqvi.net").
 *
 * Resolution order:
 * 1. localStorage("mqvi_server_url") — user's explicit setting
 * 2. VITE_SERVER_URL env var — build-time default
 * 3. "https://mqvi.net" — hardcoded fallback for Electron
 * 4. "" — same-origin (web mode)
 */
function resolveServerUrl(): string {
  if (!isElectron()) return "";

  const stored = localStorage.getItem("mqvi_server_url");
  if (stored) return stored.replace(/\/$/, "");

  const envUrl = import.meta.env.VITE_SERVER_URL;
  if (envUrl) return (envUrl as string).replace(/\/$/, "");

  return "https://mqvi.net";
}

/** Server base URL — absolute in Electron mode, empty in web mode */
export const SERVER_URL = resolveServerUrl();

/** API base URL — e.g. "https://mqvi.net/api" or "/api" */
export const API_BASE_URL = `${SERVER_URL}/api`;

/** WebSocket endpoint — e.g. "wss://mqvi.net/ws" or "wss://localhost:9090/ws" */
export const WS_URL = SERVER_URL
  ? `${SERVER_URL.replace(/^http/, "ws")}/ws`
  : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;

/**
 * Resolves a relative asset path to an absolute URL.
 * In web mode (same-origin), paths like "/api/uploads/abc.jpg" work as-is.
 * In Electron mode, we need to prepend the server URL.
 */
export function resolveAssetUrl(path: string): string {
  if (!path) return path;
  if (path.startsWith("http") || path.startsWith("data:") || path.startsWith("blob:")) return path;
  return `${SERVER_URL}${path}`;
}

/**
 * Vite public dizinindeki asset'lere güvenli referans.
 *
 * Web modda base '/' → '/mqvi-icon.svg' (absolute, çalışır)
 * Electron modda base './' → './mqvi-icon.svg' (relative, file:// ile çalışır)
 *
 * Neden gerekli? JSX'teki '/mqvi-icon.svg' literal string'i Vite tarafından
 * dönüştürülmez (sadece index.html'deki href'ler dönüşür).
 * Electron'da file:///mqvi-icon.svg → bulunamaz hatası verir.
 */
export function publicAsset(filename: string): string {
  return `${import.meta.env.BASE_URL}${filename}`;
}

/** WebSocket heartbeat interval (ms) */
export const WS_HEARTBEAT_INTERVAL = 30_000;

/** WebSocket heartbeat miss threshold — disconnect after this many missed heartbeats */
export const WS_HEARTBEAT_MAX_MISS = 3;

/** Default message count (pagination) */
export const DEFAULT_MESSAGE_LIMIT = 50;

/** Max file upload size (bytes) — 25MB */
export const MAX_FILE_SIZE = 25 * 1024 * 1024;

/** Allowed file MIME types for upload */
export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "application/pdf",
  "text/plain",
] as const;

/** Idle detection — timeout in ms. User becomes "idle" after 5 minutes of inactivity. */
export const IDLE_TIMEOUT = 5 * 60 * 1000;

/** Idle detection — DOM events that count as user activity. */
export const ACTIVITY_EVENTS = ["mousemove", "keydown", "mousedown", "scroll", "touchstart"] as const;

/**
 * Permission bit flags — must match backend values.
 * Combined with bitwise OR (|), checked with AND (&).
 *
 * Example: Does the user have SEND_MESSAGES?
 *   (userPerms & Permission.SEND_MESSAGES) !== 0
 */
export const Permission = {
  MANAGE_CHANNELS: 1 << 0,   // 1
  MANAGE_ROLES: 1 << 1,      // 2
  KICK_MEMBERS: 1 << 2,      // 4
  BAN_MEMBERS: 1 << 3,       // 8
  MANAGE_MESSAGES: 1 << 4,   // 16
  SEND_MESSAGES: 1 << 5,     // 32
  CONNECT_VOICE: 1 << 6,     // 64
  SPEAK: 1 << 7,             // 128
  STREAM: 1 << 8,            // 256
  ADMIN: 1 << 9,             // 512
} as const;
