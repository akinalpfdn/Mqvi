import { apiClient, uploadRequest, type UploadOptions } from "./client";
import type { Server } from "../types";

/** A public server card from the discovery directory (preview data only). */
export type PublicServerListItem = {
  id: string;
  name: string;
  icon_url: string | null;
  banner_url: string | null;
  description: string | null;
  category: string | null;
  member_count: number;
  online_count: number;
  verified: boolean;
  featured: boolean;
  approval_required: boolean;
  is_member: boolean;
};

export type PublicServerListPage = {
  items: PublicServerListItem[];
  total: number;
};

export type DiscoveryQuery = {
  q?: string;
  category?: string;
  featured?: boolean;
  excludeFeatured?: boolean;
  page?: number;
  limit?: number;
};

export async function listPublicServers(params: DiscoveryQuery) {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.category) qs.set("category", params.category);
  if (params.featured) qs.set("featured", "true");
  if (params.excludeFeatured) qs.set("exclude_featured", "true");
  if (params.page) qs.set("page", String(params.page));
  if (params.limit) qs.set("limit", String(params.limit));
  const query = qs.toString();
  return apiClient<PublicServerListPage>(`/discovery/servers${query ? `?${query}` : ""}`);
}

export async function getPublicServer(id: string) {
  return apiClient<PublicServerListItem>(`/discovery/servers/${id}`);
}

/** pending=true → an approval request was created (no membership yet). */
export async function joinPublicServer(id: string) {
  return apiClient<{ pending: boolean; server?: Server }>(`/discovery/servers/${id}/join`, {
    method: "POST",
  });
}

/** Report a public server for discovery moderation. Uses multipart when evidence files are given. */
export async function reportServer(
  id: string,
  reason: string,
  description: string,
  files?: File[],
  upload?: UploadOptions
) {
  if (files && files.length > 0) {
    const formData = new FormData();
    formData.append("reason", reason);
    formData.append("description", description);
    for (const file of files) {
      formData.append("files", file);
    }
    return uploadRequest<{ message: string }>(`/discovery/servers/${id}/report`, formData, upload);
  }
  return apiClient<{ message: string }>(`/discovery/servers/${id}/report`, {
    method: "POST",
    body: { reason, description },
  });
}
