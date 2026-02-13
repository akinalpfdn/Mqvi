/**
 * Search API — FTS5 tam metin arama endpoint'i.
 *
 * searchMessages: Mesajlarda tam metin araması yapar.
 * Opsiyonel kanal filtresi ve pagination destekler.
 */

import { apiClient } from "./client";
import type { Message } from "../types";

/** Arama sonucu tipi — mesajlar + toplam sayı (pagination için). */
export type SearchResult = {
  messages: Message[];
  total_count: number;
};

/**
 * searchMessages — FTS5 ile mesaj araması yapar.
 *
 * @param query Arama terimi (min 1, max 100 karakter)
 * @param channelId Opsiyonel kanal filtresi
 * @param limit Sonuç sayısı (default 25)
 * @param offset Pagination offset (default 0)
 */
export async function searchMessages(
  query: string,
  channelId?: string,
  limit = 25,
  offset = 0
) {
  const params = new URLSearchParams({ q: query });
  if (channelId) params.set("channel_id", channelId);
  if (limit !== 25) params.set("limit", String(limit));
  if (offset > 0) params.set("offset", String(offset));

  return apiClient<SearchResult>(`/search?${params.toString()}`);
}
