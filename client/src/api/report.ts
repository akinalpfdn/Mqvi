/**
 * Report API — user reporting endpoint.
 *
 * Supports multipart (with evidence files) or JSON body.
 */

import { apiClient } from "./client";

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

/** Reports a user. Uses multipart/form-data when evidence files are provided. */
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
