/**
 * Link Preview API — fetches Open Graph metadata for URLs.
 *
 * GET /api/link-preview?url=...
 *
 * Server-side fetch with SSRF protection. Results cached in SQLite (24h TTL).
 */

import { apiClient } from "./client";
import type { LinkPreview } from "../types";

export async function getLinkPreview(url: string) {
  return apiClient<LinkPreview>(`/link-preview?url=${encodeURIComponent(url)}`);
}
