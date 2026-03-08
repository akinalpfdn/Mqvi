/**
 * Link Preview API — URL Open Graph metadata endpoint'i.
 *
 * GET /api/link-preview?url=...
 *
 * Server-side fetch ile SSRF korumalı OG metadata çeker.
 * Sonuçlar backend'de SQLite cache'lenir (24 saat TTL).
 */

import { apiClient } from "./client";
import type { LinkPreview } from "../types";

/** URL'in Open Graph metadata'sını çeker */
export async function getLinkPreview(url: string) {
  return apiClient<LinkPreview>(`/link-preview?url=${encodeURIComponent(url)}`);
}
