/**
 * GIF API — Klipy GIF arama ve trending endpoint'leri.
 *
 * Backend Klipy API proxy'si üzerinden çalışır.
 * API key backend'de tutulur, client'a açılmaz.
 *
 * Klipy, Tenor'un halefidir — Discord/WhatsApp dahil geçiş yapıldı.
 * KLIPY_API_KEY yapılandırılmamışsa 503 döner.
 */

import { apiClient } from "./client";

/** GIF arama/trending sonucu — backend'in döndüğü simplified format. */
export type GifResult = {
  id: string;
  title: string;
  preview_url: string; // xs gif — picker thumbnail (küçük, hızlı)
  url: string;         // md gif — mesajda gönderilecek orta boyut
  width: number;
  height: number;
};

/** Backend'in döndüğü paginated GIF response. */
type GifResponse = {
  results: GifResult[];
  has_next: boolean; // sonraki sayfa var mı
};

/**
 * trendingGifs — Popüler GIF'leri getirir.
 *
 * GIF picker ilk açıldığında ve arama kutusu boşken kullanılır.
 */
export function trendingGifs(perPage = 24, page = 1) {
  return apiClient<GifResponse>(`/gifs/trending?per_page=${perPage}&page=${page}`);
}

/**
 * searchGifs — GIF arama yapar.
 *
 * Kullanıcı GIF picker'da arama yazarken debounced olarak çağrılır.
 */
export function searchGifs(query: string, perPage = 24, page = 1) {
  return apiClient<GifResponse>(`/gifs/search?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`);
}
