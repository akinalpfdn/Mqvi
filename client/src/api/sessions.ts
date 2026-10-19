/**
 * Active devices API — list this account's signed-in devices and sign them out.
 */

import { apiClient } from "./client";
import type { DeviceSession } from "../types";

export function listSessions() {
  return apiClient<DeviceSession[]>("/auth/sessions");
}

export function revokeSession(id: string) {
  return apiClient<null>(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function revokeOtherSessions() {
  return apiClient<{ revoked: number }>("/auth/sessions", { method: "DELETE" });
}
