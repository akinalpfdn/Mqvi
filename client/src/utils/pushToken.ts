/**
 * Push token registration — the device's message token (FCM on Android, an APNs device
 * token on iOS) and, on iOS, the PushKit VoIP token. Both are mirrored in localStorage so
 * logout can unregister them. Kept separate from the hooks so non-UI code (authStore) can
 * import the unregister helpers without pulling in React or the navigation stores.
 *
 * A token is registered per server: the app can be pointed at a different deployment, and
 * each one keeps its own push_tokens row. Sending it once and hoping is not enough — a
 * single failed request used to leave that server unable to reach the device, silently and
 * until the app was reinstalled. So every send is retried, the result is recorded against
 * the server it was sent to, and an old record is re-asserted so a row the server has since
 * dropped comes back.
 */

import { registerPushToken, unregisterPushToken } from "../api/push";
import { getCapacitorPlatform, SERVER_URL } from "./constants";

const PUSH_TOKEN_KEY = "mqvi_push_token";
const VOIP_TOKEN_KEY = "mqvi_voip_token";
/** What we last got the server to accept, per token type. */
const REGISTERED_KEY = "mqvi_push_registered";

const ATTEMPTS = 3;
const BACKOFF_MS = 2_000;
/** A confirmed registration is taken on trust for this long, then asserted again. */
const REASSERT_MS = 30 * 60 * 1000;

type TokenType = "fcm" | "apns" | "apns_voip";
type Registration = { server: string; token: string; at: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readRegistrations(): Record<string, Registration> {
  try {
    const raw = localStorage.getItem(REGISTERED_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Registration>) : {};
  } catch {
    return {};
  }
}

function writeRegistration(type: TokenType, entry: Registration | null): void {
  const all = readRegistrations();
  if (entry) all[type] = entry;
  else delete all[type];
  try {
    localStorage.setItem(REGISTERED_KEY, JSON.stringify(all));
  } catch {
    // A full or disabled store only costs us the shortcut below; the token still registers.
  }
}

/** True when this exact token is already registered with this server and recently enough. */
function alreadyRegistered(type: TokenType, token: string): boolean {
  const entry = readRegistrations()[type];
  return (
    !!entry &&
    entry.token === token &&
    entry.server === SERVER_URL &&
    Date.now() - entry.at < REASSERT_MS
  );
}

/**
 * Sends a token to the current server until it sticks. Leaves no record on failure, so the
 * next launch or foreground tries again rather than assuming the server has it.
 */
async function syncToken(type: TokenType, token: string, platform: "ios" | "android"): Promise<void> {
  if (alreadyRegistered(type, token)) return;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const res = await registerPushToken({ token, platform, token_type: type });
    if (res.success) {
      writeRegistration(type, { server: SERVER_URL, token, at: Date.now() });
      return;
    }
    if (attempt < ATTEMPTS) await sleep(BACKOFF_MS * attempt);
  }
  writeRegistration(type, null);
  console.error(`[push] ${type} token registration failed after ${ATTEMPTS} attempts`);
}

/** Caches the message push token locally and registers it with the backend. Android
 * gets an FCM token; iOS gets a raw APNs device token (no Firebase on iOS) delivered as
 * a direct APNs alert — so the token_type must match the platform. */
export async function syncPushToken(value: string): Promise<void> {
  const platform = getCapacitorPlatform();
  if (platform !== "android" && platform !== "ios") return;
  localStorage.setItem(PUSH_TOKEN_KEY, value);
  await syncToken(platform === "ios" ? "apns" : "fcm", value, platform);
}

/**
 * Caches and registers the iOS PushKit VoIP token. Calls reach iOS through this token
 * alone — the alert token is skipped for them — so a device missing it rings for nothing
 * while its message notifications keep arriving, which is what hid the failure.
 */
export async function syncVoipToken(token: string): Promise<void> {
  if (!token) return;
  localStorage.setItem(VOIP_TOKEN_KEY, token);
  await syncToken("apns_voip", token, "ios");
}

/** Removes this device's push tokens (FCM + VoIP) from the backend. Called on logout. */
export async function unregisterCurrentPushToken(): Promise<void> {
  const fcm = localStorage.getItem(PUSH_TOKEN_KEY);
  const voip = localStorage.getItem(VOIP_TOKEN_KEY);
  try {
    if (fcm) await unregisterPushToken(fcm);
    if (voip) await unregisterPushToken(voip);
  } finally {
    localStorage.removeItem(PUSH_TOKEN_KEY);
    localStorage.removeItem(VOIP_TOKEN_KEY);
    localStorage.removeItem(REGISTERED_KEY);
  }
}

/**
 * Clears only the local token caches (no server call). Used when a session restore
 * fails: the access token is already invalid so we can't unregister server-side.
 * The server row self-heals on next login (token upsert reassigns user_id); a
 * server-side prune on session revoke is the complete fix (tracked for a later phase).
 */
export function clearCachedPushToken(): void {
  localStorage.removeItem(PUSH_TOKEN_KEY);
  localStorage.removeItem(VOIP_TOKEN_KEY);
  localStorage.removeItem(REGISTERED_KEY);
}
