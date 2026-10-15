/**
 * Report API — user reporting endpoint.
 *
 * Supports multipart (with evidence files) or JSON body.
 */

import { apiClient, uploadRequest, type UploadOptions } from "./client";

export type ReportReason =
  | "spam"
  | "harassment"
  | "inappropriate_content"
  | "impersonation"
  | "other";

export type CreateReportRequest = {
  reason: ReportReason;
  description: string;
  /** Message-level report: exactly one of the ids, plus an excerpt of the text. */
  message_id?: string;
  dm_message_id?: string;
  voice_message_id?: string;
  /** Only used for E2EE messages; the server snapshots plaintext itself. */
  message_excerpt?: string;
};

/** Message being reported, as seen by the reporter's client. */
export type ReportMessageContext = {
  kind: "channel" | "dm" | "voice";
  id: string;
  excerpt: string;
  encrypted: boolean;
};

const MESSAGE_ID_FIELD: Record<ReportMessageContext["kind"], "message_id" | "dm_message_id" | "voice_message_id"> = {
  channel: "message_id",
  dm: "dm_message_id",
  voice: "voice_message_id",
};

/** Max excerpt length accepted by the server (models.MaxReportExcerptLength). */
export const REPORT_EXCERPT_MAX = 500;

export function messageContextToRequest(
  ctx: ReportMessageContext,
): Pick<CreateReportRequest, "message_id" | "dm_message_id" | "voice_message_id" | "message_excerpt"> {
  return {
    [MESSAGE_ID_FIELD[ctx.kind]]: ctx.id,
    message_excerpt: ctx.excerpt.slice(0, REPORT_EXCERPT_MAX),
  };
}

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
export function reportUser(
  userId: string,
  req: CreateReportRequest,
  files?: File[],
  upload?: UploadOptions
) {
  if (files && files.length > 0) {
    const formData = new FormData();
    formData.append("reason", req.reason);
    formData.append("description", req.description);
    if (req.message_id) formData.append("message_id", req.message_id);
    if (req.dm_message_id) formData.append("dm_message_id", req.dm_message_id);
    if (req.voice_message_id) formData.append("voice_message_id", req.voice_message_id);
    if (req.message_excerpt) formData.append("message_excerpt", req.message_excerpt);
    for (const file of files) {
      formData.append("files", file);
    }
    return uploadRequest<Report>(`/users/${userId}/report`, formData, upload);
  }

  return apiClient<Report>(`/users/${userId}/report`, {
    method: "POST",
    body: req,
  });
}
