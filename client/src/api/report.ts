/**
 * Report API — Kullanıcı raporlama endpoint'i.
 *
 *   reportUser: Kullanıcıyı raporla (predefined reason + zorunlu açıklama + opsiyonel resim delilleri).
 *
 * Multipart/JSON dual support:
 * - Dosya varsa: FormData (multipart/form-data)
 * - Dosya yoksa: JSON body (backward compat)
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

/** Rapor delili dosyası — backend'den dönen attachment bilgisi. */
export type ReportAttachment = {
  id: string;
  report_id: string;
  filename: string;
  file_url: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
};

export type Report = {
  id: string;
  reporter_id: string;
  reported_user_id: string;
  reason: ReportReason;
  description: string;
  status: string;
  created_at: string;
  attachments: ReportAttachment[];
};

/**
 * reportUser — Kullanıcıyı raporla.
 *
 * files parametresi varsa multipart/form-data gönderilir (delil resimleri).
 * Yoksa JSON body gönderilir (backward compat).
 * Browser FormData kullanıldığında Content-Type header'ını otomatik ayarlar.
 */
export function reportUser(userId: string, req: CreateReportRequest, files?: File[]) {
  if (files && files.length > 0) {
    const formData = new FormData();
    formData.append("reason", req.reason);
    formData.append("description", req.description);
    for (const file of files) {
      formData.append("files", file);
    }
    return apiClient<Report>(`/users/${userId}/report`, {
      method: "POST",
      body: formData,
    });
  }

  return apiClient<Report>(`/users/${userId}/report`, {
    method: "POST",
    body: req,
  });
}
