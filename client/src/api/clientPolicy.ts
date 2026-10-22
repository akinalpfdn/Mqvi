/**
 * Client policy API — what the server requires of the mobile apps (no auth required).
 */

import { apiClient } from "./client";
import type { APIResponse } from "../types";

export type ClientPolicy = {
  /** Oldest app version this server serves, per platform; "" means no minimum. */
  min_versions: { android: string; ios: string };
};

export async function getClientPolicy(): Promise<APIResponse<ClientPolicy>> {
  return apiClient<ClientPolicy>("/client-policy");
}
