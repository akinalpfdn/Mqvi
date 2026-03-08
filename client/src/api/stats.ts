/**
 * Stats API — public statistics endpoints (no auth required).
 */

import { apiClient } from "./client";
import type { APIResponse } from "../types";

export type PublicStats = {
  total_users: number;
};

/** Returns total registered user count. Called from the landing page. */
export async function getPublicStats(): Promise<APIResponse<PublicStats>> {
  return apiClient<PublicStats>("/stats");
}
