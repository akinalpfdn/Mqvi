/**
 * Stats API — Public istatistik endpoint'leri.
 * Auth gerekmez — landing page'den çağrılır.
 */

import { apiClient } from "./client";
import type { APIResponse } from "../types";

/** Backend'den dönen public stats tipi */
export type PublicStats = {
  total_users: number;
};

/**
 * getPublicStats — Toplam kayıtlı kullanıcı sayısını getirir.
 * Auth token olmadan da çalışır (apiClient token yoksa header eklemez).
 *
 * GET /api/stats
 */
export async function getPublicStats(): Promise<APIResponse<PublicStats>> {
  return apiClient<PublicStats>("/stats");
}
