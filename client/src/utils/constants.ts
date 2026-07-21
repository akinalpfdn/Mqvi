/**
 * Application-wide constants.
 * No hardcoded values elsewhere — every constant goes here.
 */

import { Capacitor } from "@capacitor/core";

// ─── Platform Detection ───

/**
 * Detects if the app is running inside an Electron desktop shell.
 * Electron preload script injects window.electronAPI via contextBridge.
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.electronAPI;
}

/**
 * Detects if the app is running inside a Capacitor native shell (iOS/Android).
 * Capacitor injects a bridge object at runtime.
 */
export function isCapacitor(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * Returns the Capacitor platform: "ios", "android", or "web".
 */
export function getCapacitorPlatform(): string {
  return Capacitor.getPlatform();
}

/**
 * Detects if the app is running in any native shell (Electron or Capacitor).
 * These environments need absolute server URLs (no Vite proxy).
 */
export function isNativeApp(): boolean {
  return isElectron() || isCapacitor();
}

// ─── Server URL Resolution ───

/**
 * Resolves the server base URL based on runtime environment.
 *
 * Web mode: "" (same-origin, relative paths work via Vite proxy or nginx).
 * Native mode (Electron/Capacitor): absolute URL needed — no proxy available.
 *
 * Resolution order:
 * 1. localStorage("mqvi_server_url")
 * 2. VITE_SERVER_URL env var
 * 3. "https://mqvi.net" (native fallback)
 * 4. "" (web mode)
 */
function resolveServerUrl(): string {
  if (!isNativeApp()) return "";

  const stored = localStorage.getItem("mqvi_server_url");
  if (stored) return stored.replace(/\/$/, "");

  const envUrl = import.meta.env.VITE_SERVER_URL;
  if (envUrl) return (envUrl as string).replace(/\/$/, "");

  return "https://mqvi.net";
}

/** Absolute in native mode (Electron/Capacitor), empty in web mode */
export const SERVER_URL = resolveServerUrl();

export const API_BASE_URL = `${SERVER_URL}/api`;

/**
 * Generates a public invite URL for sharing outside the app.
 * Result: "https://mqvi.net/invite/{code}"
 */
export function getInviteUrl(code: string): string {
  const base = SERVER_URL || window.location.origin;
  return `${base}/invite/${code}`;
}

export const WS_URL = SERVER_URL
  ? `${SERVER_URL.replace(/^http/, "ws")}/ws`
  : `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;

/**
 * Resolves relative asset paths to absolute URLs.
 * In Electron mode, prepends SERVER_URL for file:// context.
 */
export function resolveAssetUrl(path: string): string {
  if (!path) return path;
  if (path.startsWith("http") || path.startsWith("data:") || path.startsWith("blob:")) return path;
  return `${SERVER_URL}${path}`;
}

/**
 * Safe reference to Vite public directory assets.
 * In Electron, base is "./" (relative, works with file://).
 * In web, base is "/" (absolute).
 */
export function publicAsset(filename: string): string {
  return `${import.meta.env.BASE_URL}${filename}`;
}

/**
 * Clipboard copy — Electron and web compatible.
 *
 * Priority: Electron native clipboard > navigator.clipboard > execCommand fallback.
 * In Electron file:// context, navigator.clipboard doesn't work.
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (isElectron() && window.electronAPI?.writeClipboard) {
    await window.electronAPI.writeClipboard(text);
    return;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // No secure context — fall through to execCommand
    }
  }

  // execCommand fallback for file:// and older browsers
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

// ─── Screen Share Identity ───

/**
 * Suffix appended to user IDs for iOS native screen share participants.
 * These participants connect via LiveKit Swift SDK (separate from the JS SDK connection)
 * and only publish screen share tracks.
 */
export const SCREEN_SHARE_IDENTITY_SUFFIX = "_ss";

/**
 * Resolves the real user ID from a LiveKit participant identity.
 * Strips the "_ss" suffix from iOS native screen share sub-participants.
 */
export function resolveUserId(identity: string): string {
  if (identity.endsWith(SCREEN_SHARE_IDENTITY_SUFFIX)) {
    return identity.slice(0, -SCREEN_SHARE_IDENTITY_SUFFIX.length);
  }
  return identity;
}

/** The track name the native Windows capture helper publishes under — see native/game-capture. */
export const NATIVE_CAPTURE_TRACK_NAME = "native-game-capture";

/** Which engine drew a screen share. */
export type ShareEngine = "smooth" | "mobile" | "sharp";

/**
 * Names the engine behind a share, from what the publication already carries.
 *
 * The identity alone cannot do it: the "_ss" sub-participant is how *every* native share arrives,
 * the phone's included. Only the track name separates our Windows helper from a ReplayKit or
 * MediaProjection stream, and calling those "Akıcı Görüntü" would be a lie.
 */
export function shareEngine(trackName: string, identity: string): ShareEngine {
  if (trackName === NATIVE_CAPTURE_TRACK_NAME) return "smooth";
  if (isScreenShareIdentity(identity)) return "mobile";
  return "sharp";
}

/**
 * Returns true if the identity belongs to a screen share sub-participant (iOS native).
 */
export function isScreenShareIdentity(identity: string): boolean {
  return identity.endsWith(SCREEN_SHARE_IDENTITY_SUFFIX);
}

/** WebSocket heartbeat interval (ms) */
export const WS_HEARTBEAT_INTERVAL = 30_000;

/**
 * Heartbeat interval used right after the app returns from background (ms).
 * readyState can still read OPEN on a socket the server already dropped, so the
 * probe interval shortens dead-socket detection to 3 × 10s. Restored to
 * WS_HEARTBEAT_INTERVAL on the first ack, keeping steady-state radio wakeups unchanged.
 */
export const WS_HEARTBEAT_PROBE_INTERVAL = 10_000;

/** WebSocket heartbeat miss threshold — disconnect after this many missed heartbeats */
export const WS_HEARTBEAT_MAX_MISS = 3;

/** Reconnect attempts before the failure banner is shown. Retries continue past this. */
export const WS_MAX_RECONNECT_ATTEMPTS = 7;

/** Default message count (pagination) */
export const DEFAULT_MESSAGE_LIMIT = 50;

/** Max message length (characters) — synced with backend models.MaxMessageLength */
export const MAX_MESSAGE_LENGTH = 999;

/** Mirrors password.MinLength on the server. A pre-check only — the server is the authority. */
export const PASSWORD_MIN_LENGTH = 12;

/** bcrypt's hard ceiling. Turkish letters are two bytes each, so this bites well before 72 characters. */
export const PASSWORD_MAX_BYTES = 72;

export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length;
}

/** Max upload (bytes). Bounded by the server's UPLOAD_MAX_SIZE and Cloudflare Free's 100MB body cap. */
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

/** Max E2EE attachment. Encryption holds the file plus its ciphertext, so 100MB would peak at 200MB+. */
export const MAX_E2EE_FILE_SIZE = 25 * 1024 * 1024;


/**
 * Mirrors avatarMaxSize in server/handlers/avatar.go — avatar, wallpaper and server icon all go
 * through the same processUpload path and share this cap.
 */
export const MAX_AVATAR_UPLOAD_SIZE = 8 * 1024 * 1024;

/**
 * Output cap for avatars and server icons, in pixels.
 *
 * 512 rather than the ~300 the UI needs: a 3× DPR profile card wants real pixels, and at this scale
 * the byte difference is nothing next to the multi-megabyte originals this replaces.
 */
export const AVATAR_OUTPUT_SIZE = 512;

/** Output cap for server banners. 16:9, matching --banner-aspect / BANNER_ASPECT. */
export const BANNER_OUTPUT_WIDTH = 1920;
export const BANNER_OUTPUT_HEIGHT = 1080;

/** Mirrors badgeIconMaxSize in server/handlers/badge.go. */
export const MAX_BADGE_ICON_SIZE = 2 * 1024 * 1024;

/**
 * Attachments per message. Mirrors maxMessageUploadFiles / maxDMUploadFiles on the server, which
 * rejects the whole send past this — so the cap has to bite at selection, not at submit.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * How many attachment previews are generated at once.
 *
 * Each one decodes a full-size bitmap, so ten 12MP photos in parallel is hundreds of megabytes and
 * an OOM on a mobile WebView. Two keeps the main thread fed without holding the whole batch.
 */
export const PREVIEW_CONCURRENCY = 2;

// ─── Feedback / report attachments ───

const FEEDBACK_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/**
 * What a feedback ticket or reply accepts. Mirrors isAllowedFeedbackMime in
 * server/services/feedback_upload_service.go — video is matched by prefix on both sides so a
 * container the list never anticipated (.mov from a Mac, .m4v) is not silently refused.
 */
export function isFeedbackAttachment(mime: string): boolean {
  return mime.startsWith("video/") || FEEDBACK_IMAGE_TYPES.includes(mime);
}

/** Value for the `accept` attribute of every feedback file input. */
export const FEEDBACK_ACCEPT_ATTR = `${FEEDBACK_IMAGE_TYPES.join(",")},video/*`;

/** Idle detection — timeout in ms. User becomes "idle" after 5 minutes of inactivity. */
export const IDLE_TIMEOUT = 5 * 60 * 1000;

/** Idle detection — DOM events that count as user activity. */
export const ACTIVITY_EVENTS = ["mousemove", "keydown", "mousedown", "scroll", "touchstart"] as const;

/**
 * Permission bit flags — must match backend values.
 * Combined with bitwise OR (|), checked with AND (&).
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
