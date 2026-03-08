/**
 * Search API — FTS5 full-text search, server-scoped.
 */

import { apiClient } from "./client";
import type { Message } from "../types";

export type SearchResult = {
  messages: Message[];
  total_count: number;
};

/** FTS5 message search with optional channel filter and pagination. */
export async function searchMessages(
  serverId: string,
  query: string,
  channelId?: string,
  limit = 25,
  offset = 0
) {
  const params = new URLSearchParams({ q: query });
  if (channelId) params.set("channel_id", channelId);
  if (limit !== 25) params.set("limit", String(limit));
  if (offset > 0) params.set("offset", String(offset));

  return apiClient<SearchResult>(`/servers/${serverId}/search?${params.toString()}`);
}
