/**
 * Badge API — badge CRUD, assignment, and icon upload.
 */

import { apiClient } from "./client";
import type { Badge, UserBadge } from "../types";

/** List all badge templates. */
export async function listBadges() {
  return apiClient<Badge[]>("/badges");
}

/** Create a new badge template. */
export async function createBadge(body: {
  name: string;
  icon: string;
  icon_type: "builtin" | "custom";
  color1: string;
  color2: string | null;
}) {
  return apiClient<Badge>("/badges", { method: "POST", body });
}

/** Update an existing badge template. */
export async function updateBadge(
  badgeId: string,
  body: {
    name: string;
    icon: string;
    icon_type: "builtin" | "custom";
    color1: string;
    color2: string | null;
  }
) {
  return apiClient<Badge>(`/badges/${badgeId}`, { method: "PATCH", body });
}

/** Delete a badge template. */
export async function deleteBadge(badgeId: string) {
  return apiClient<{ message: string }>(`/badges/${badgeId}`, {
    method: "DELETE",
  });
}

/** Assign a badge to a user. */
export async function assignBadge(badgeId: string, userId: string) {
  return apiClient<UserBadge>(`/badges/${badgeId}/assign`, {
    method: "POST",
    body: { user_id: userId },
  });
}

/** Unassign a badge from a user. */
export async function unassignBadge(badgeId: string, userId: string) {
  return apiClient<{ message: string }>(
    `/badges/${badgeId}/assign/${userId}`,
    { method: "DELETE" }
  );
}

/** Get all badges assigned to a user. */
export async function getUserBadges(userId: string) {
  return apiClient<UserBadge[]>(`/users/${userId}/badges`);
}

/** Upload a custom badge icon image. Returns the URL path. */
export async function uploadBadgeIcon(file: File) {
  const formData = new FormData();
  formData.append("icon", file);
  return apiClient<{ url: string }>("/badges/icon", {
    method: "POST",
    body: formData,
  });
}
