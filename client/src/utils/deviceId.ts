/**
 * A stable id for this installation, so the server can address one of a user's devices instead
 * of all of them.
 *
 * Deliberately NOT the E2EE device id: that one is optional (encryption can be off), can be
 * `error`, and is null until the crypto layer finishes initializing — a call would then be
 * unroutable for anyone in those states.
 *
 * Survives reconnects and restarts, unlike the per-connection session id the server mints.
 * Two Electron windows of the same install share it, which is correct: they are one device as
 * far as push notifications are concerned.
 */

const DEVICE_ID_KEY = "mqvi_device_id";

/**
 * This running app: new on every page load, kept across reconnects, different in every tab and
 * window. Only it tells the server "the app that answered is back on a new socket" apart from
 * "another tab of the same install", which shares the device id.
 */
export const INSTANCE_ID = crypto.randomUUID();

let cached: string | null = null;

export function getDeviceId(): string {
  if (cached) return cached;

  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  cached = id;
  return id;
}
