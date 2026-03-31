import { apiClient } from "./client";
import type { FeedbackTicket, FeedbackReply } from "../types";

// ─── User Endpoints ───

export async function createFeedbackTicket(data: {
  type: string;
  subject: string;
  content: string;
}) {
  return apiClient.post<FeedbackTicket>("/api/feedback", data);
}

export async function listMyFeedbackTickets(limit = 20, offset = 0) {
  return apiClient.get<{ tickets: FeedbackTicket[]; total: number }>(
    `/api/feedback?limit=${limit}&offset=${offset}`
  );
}

export async function getFeedbackTicket(id: string) {
  return apiClient.get<{ ticket: FeedbackTicket; replies: FeedbackReply[] }>(
    `/api/feedback/${id}`
  );
}

export async function addFeedbackReply(ticketId: string, content: string) {
  return apiClient.post<FeedbackReply>(`/api/feedback/${ticketId}/reply`, { content });
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
  return apiClient.get<{ tickets: FeedbackTicket[]; total: number }>(
    `/api/admin/feedback?${query}`
  );
}

export async function adminGetFeedbackTicket(id: string) {
  return apiClient.get<{ ticket: FeedbackTicket; replies: FeedbackReply[] }>(
    `/api/admin/feedback/${id}`
  );
}

export async function adminReplyToFeedback(ticketId: string, content: string) {
  return apiClient.post<FeedbackReply>(`/api/admin/feedback/${ticketId}/reply`, { content });
}

export async function adminUpdateFeedbackStatus(ticketId: string, status: string) {
  return apiClient.patch<{ message: string }>(`/api/admin/feedback/${ticketId}/status`, { status });
}
