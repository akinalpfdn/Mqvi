/**
 * Device permission helpers for camera/microphone.
 *
 * On web/Electron: permissions are requested via getUserMedia (browser handles prompt).
 * On Capacitor (iOS/Android): we pre-request permissions before voice/video join
 * to ensure native permission dialogs appear before WebRTC tries to access devices.
 */

import { isCapacitor } from "./constants";

export type PermissionStatus = "granted" | "denied" | "prompt";

/**
 * Check current microphone permission status.
 */
export async function checkMicPermission(): Promise<PermissionStatus> {
  try {
    const result = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return result.state as PermissionStatus;
  } catch {
    // Firefox/older browsers don't support querying microphone permission
    return "prompt";
  }
}

/**
 * Check current camera permission status.
 */
export async function checkCameraPermission(): Promise<PermissionStatus> {
  try {
    const result = await navigator.permissions.query({ name: "camera" as PermissionName });
    return result.state as PermissionStatus;
  } catch {
    return "prompt";
  }
}

/**
 * Request microphone permission.
 * On Capacitor, this triggers the native OS permission dialog.
 * Returns true if permission was granted.
 */
export async function requestMicPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop tracks immediately — we only needed the permission prompt
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

/**
 * Request camera permission.
 * Returns true if permission was granted.
 */
export async function requestCameraPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure microphone permission is granted before joining voice.
 * On Capacitor, pre-requests to show native dialog early.
 * On web/Electron, getUserMedia will prompt automatically — this is a no-op.
 */
export async function ensureMicPermission(): Promise<boolean> {
  if (!isCapacitor()) return true;

  const status = await checkMicPermission();
  if (status === "granted") return true;
  if (status === "denied") return false;

  return requestMicPermission();
}
