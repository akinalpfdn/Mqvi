/**
 * Block API — user blocking endpoints.
 */

import { apiClient } from "./client";
import type { FriendshipWithUser } from "../types";

export function blockUser(userId: string) {
  return apiClient<void>(`/users/${userId}/block`, { method: "POST" });
}

export function unblockUser(userId: string) {
  return apiClient<void>(`/users/${userId}/block`, { method: "DELETE" });
}

export function listBlocked() {
  return apiClient<FriendshipWithUser[]>("/users/blocked");
}
