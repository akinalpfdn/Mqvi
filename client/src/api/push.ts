/**
 * Push notifications API — register/unregister this device's FCM token.
 */

import { apiClient } from "./client";
import { getDeviceId } from "../utils/deviceId";

export function registerPushToken(req: {
  token: string;
  platform: "android" | "ios" | "web";
  token_type?: "fcm" | "apns" | "apns_voip";
  device_label?: string;
}) {
  // The same device id the WebSocket handshake sends. It is what lets the server skip this
  // device when it tells the user's OTHER devices to stop ringing.
  return apiClient<{ id: string }>("/push/tokens", {
    method: "POST",
    body: { ...req, device_id: getDeviceId() },
  });
}

export function unregisterPushToken(token: string) {
  return apiClient<null>("/push/tokens", {
    method: "DELETE",
    body: { token },
  });
}
