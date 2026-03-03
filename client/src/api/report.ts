/**
 * Report API — Kullanıcı raporlama endpoint'i.
 *
 *   reportUser: Kullanıcıyı raporla (predefined reason + zorunlu açıklama).
 */

import { apiClient } from "./client";

/** Rapor nedeni — predefined seçenekler. */
export type ReportReason =
  | "spam"
  | "harassment"
  | "inappropriate_content"
  | "impersonation"
  | "other";

export type CreateReportRequest = {
  reason: ReportReason;
  description: string;
};

export type Report = {
  id: string;
  reporter_id: string;
  reported_user_id: string;
  reason: ReportReason;
  description: string;
  status: string;
  created_at: string;
};

export function reportUser(userId: string, req: CreateReportRequest) {
  return apiClient<Report>(`/users/${userId}/report`, {
    method: "POST",
    body: req,
  });
}
