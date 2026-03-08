/**
 * GIF API — Klipy GIF search and trending via backend proxy.
 *
 * API key is stored server-side. Returns 503 if KLIPY_API_KEY is not configured.
 */

import { apiClient } from "./client";

export type GifResult = {
  id: string;
  title: string;
  preview_url: string; // xs gif — picker thumbnail
  url: string;         // md gif — sent in messages
  width: number;
  height: number;
};

type GifResponse = {
  results: GifResult[];
  has_next: boolean;
};

/** Fetches trending GIFs. Used when the picker opens and search is empty. */
export function trendingGifs(perPage = 24, page = 1) {
  return apiClient<GifResponse>(`/gifs/trending?per_page=${perPage}&page=${page}`);
}

/** Searches GIFs. Called debounced as user types in the picker. */
export function searchGifs(query: string, perPage = 24, page = 1) {
  return apiClient<GifResponse>(`/gifs/search?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`);
}
