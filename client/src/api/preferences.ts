/**
 * Preferences API — server-side user preferences (theme, sidebar, voice settings).
 */

import { apiClient } from "./client";

export type UserPreferencesResponse = {
  user_id: string;
  data: Record<string, unknown>;
  updated_at: string;
};

/** Fetch all user preferences. Returns empty {} if none saved yet. */
export async function getPreferences() {
  return apiClient<UserPreferencesResponse>("/users/me/preferences", {
    method: "GET",
  });
}

/** Merge partial preferences into existing ones (top-level key merge). */
export async function updatePreferences(data: Record<string, unknown>) {
  return apiClient<UserPreferencesResponse>("/users/me/preferences", {
    method: "PATCH",
    body: { data },
  });
}
