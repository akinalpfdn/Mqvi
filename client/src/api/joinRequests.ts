import { apiClient } from "./client";
import type { JoinRequest } from "../types";

export async function listJoinRequests(serverId: string) {
  return apiClient<{ requests: JoinRequest[]; total: number }>(
    `/servers/${serverId}/requests`
  );
}

export async function getJoinRequestCount(serverId: string) {
  return apiClient<{ count: number }>(`/servers/${serverId}/requests/count`);
}

export async function approveJoinRequest(serverId: string, userId: string) {
  return apiClient<{ message: string }>(
    `/servers/${serverId}/requests/${userId}/approve`,
    { method: "POST" }
  );
}

export async function rejectJoinRequest(serverId: string, userId: string) {
  return apiClient<{ message: string }>(`/servers/${serverId}/requests/${userId}`, {
    method: "DELETE",
  });
}
