/** Onboarding guide state — which steps are done, and whether the guide is hidden. */

import { apiClient } from "./client";
import type { GuideState } from "../types";

export async function getGuide() {
  return apiClient<GuideState>("/users/me/guide");
}

/** The desktop and mobile apps report themselves; a browser never calls this. */
export async function markGuideAppUsed() {
  return apiClient<GuideState>("/users/me/guide/app", { method: "POST" });
}

export async function setGuideHidden(hidden: boolean) {
  return apiClient<GuideState>("/users/me/guide", { method: "PUT", body: { hidden } });
}
