import { apiClient } from "./client";
import type { FeedbackTicket, FeedbackReply } from "../types";

// ─── User Endpoints ───

export async function createFeedbackTicket(data: {
  type: string;
  subject: string;
  content: string;
  files?: File[];
}) {
  if (data.files && data.files.length > 0) {
    const form = new FormData();
    form.append("type", data.type);
    form.append("subject", data.subject);
    form.append("content", data.content);
    for (const file of data.files) {
      form.append("files", file);
    }
    return apiClient<FeedbackTicket>("/feedback", { method: "POST", body: form });
  }
  return apiClient<FeedbackTicket>("/feedback", { method: "POST", body: data });
}

export async function listMyFeedbackTickets(limit = 20, offset = 0) {
  return apiClient<{ tickets: FeedbackTicket[]; total: number }>(
    `/feedback?limit=${limit}&offset=${offset}`
  );
}

export async function getFeedbackTicket(id: string) {
  return apiClient<{ ticket: FeedbackTicket; replies: FeedbackReply[] }>(
    `/feedback/${id}`
  );
}

export async function addFeedbackReply(ticketId: string, content: string, files?: File[]) {
  if (files && files.length > 0) {
    const form = new FormData();
    form.append("content", content);
    for (const file of files) form.append("files", file);
    return apiClient<FeedbackReply>(`/feedback/${ticketId}/reply`, { method: "POST", body: form });
  }
  return apiClient<FeedbackReply>(`/feedback/${ticketId}/reply`, { method: "POST", body: { content } });
}

export async function deleteFeedbackTicket(id: string) {
  return apiClient<{ message: string }>(`/feedback/${id}`, { method: "DELETE" });
}

// ─── Admin Endpoints ───

export async function adminListFeedbackTickets(
  params: { status?: string; type?: string; limit?: number; offset?: number } = {}
) {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.type) query.set("type", params.type);
  query.set("limit", String(params.limit ?? 50));
  query.set("offset", String(params.offset ?? 0));
  return apiClient<{ tickets: FeedbackTicket[]; total: number }>(
    `/admin/feedback?${query}`
  );
}

export async function adminGetFeedbackTicket(id: string) {
  return apiClient<{ ticket: FeedbackTicket; replies: FeedbackReply[] }>(
    `/admin/feedback/${id}`
  );
}

export async function adminReplyToFeedback(ticketId: string, content: string, files?: File[]) {
  if (files && files.length > 0) {
    const form = new FormData();
    form.append("content", content);
    for (const file of files) form.append("files", file);
    return apiClient<FeedbackReply>(`/admin/feedback/${ticketId}/reply`, { method: "POST", body: form });
  }
  return apiClient<FeedbackReply>(`/admin/feedback/${ticketId}/reply`, { method: "POST", body: { content } });
}

export async function adminUpdateFeedbackStatus(ticketId: string, status: string) {
  return apiClient<{ message: string }>(`/admin/feedback/${ticketId}/status`, {
    method: "PATCH",
    body: { status },
  });
}
