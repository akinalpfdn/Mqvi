/**
 * Uygulama genelinde kullanılan sabit değerler.
 * Hardcode değerler YASAK — her sabit buraya eklenir.
 */

/** API base URL — Vite proxy kullandığımız için relative path yeterli */
export const API_BASE_URL = "/api";

/** WebSocket endpoint */
export const WS_URL = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;

/** WebSocket heartbeat interval (ms) */
export const WS_HEARTBEAT_INTERVAL = 30_000;

/** WebSocket heartbeat miss threshold (bu kadar miss olursa disconnect) */
export const WS_HEARTBEAT_MAX_MISS = 3;

/** Varsayılan mesaj sayısı (pagination) */
export const DEFAULT_MESSAGE_LIMIT = 50;

/** Maksimum dosya boyutu (byte) — 25MB */
export const MAX_FILE_SIZE = 25 * 1024 * 1024;

/** İzin verilen dosya MIME tipleri */
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

/**
 * Permission bit flags — backend ile aynı değerler.
 * Bitwise OR (|) ile birleştirilebilir, AND (&) ile kontrol edilir.
 *
 * Örnek: Bir kullanıcının SEND_MESSAGES yetkisi var mı?
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
