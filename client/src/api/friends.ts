/**
 * Friends API — Arkadaşlık sistemi endpoint'leri.
 *
 * listFriends: Kabul edilmiş arkadaşları listeler.
 * listRequests: Gelen ve giden arkadaşlık isteklerini listeler.
 * sendRequest: Username ile arkadaşlık isteği gönderir.
 * acceptRequest: Gelen isteği kabul eder.
 * declineRequest: Gelen isteği reddeder veya gönderilen isteği iptal eder.
 * removeFriend: Mevcut arkadaşlığı kaldırır.
 */

import { apiClient } from "./client";
import type { FriendshipWithUser, FriendRequestsResponse } from "../types";

export function listFriends() {
  return apiClient<FriendshipWithUser[]>("/friends");
}

export function listRequests() {
  return apiClient<FriendRequestsResponse>("/friends/requests");
}

export function sendRequest(username: string) {
  return apiClient<FriendshipWithUser>("/friends/requests", {
    method: "POST",
    body: { username },
  });
}

export function acceptRequest(requestId: string) {
  return apiClient<FriendshipWithUser>(`/friends/requests/${requestId}/accept`, {
    method: "POST",
  });
}

export function declineRequest(requestId: string) {
  return apiClient<{ message: string }>(`/friends/requests/${requestId}`, {
    method: "DELETE",
  });
}

export function removeFriend(userId: string) {
  return apiClient<{ message: string }>(`/friends/${userId}`, {
    method: "DELETE",
  });
}
