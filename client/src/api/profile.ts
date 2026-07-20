/**
 * Profile API — profile update and avatar upload.
 *
 * Both endpoints return updated MemberWithRoles for immediate state sync.
 */

import { apiClient, uploadRequest, type UploadOptions } from "./client";
import type { MemberWithRoles } from "../types";

type UpdateProfileRequest = {
  username?: string;
  display_name?: string | null;
  custom_status?: string | null;
  language?: string;
  dm_privacy?: string;
};

export async function updateProfile(data: UpdateProfileRequest) {
  return apiClient<MemberWithRoles>("/users/me/profile", {
    method: "PATCH",
    body: data,
  });
}

/** Uploads avatar via multipart/form-data. Browser sets Content-Type with boundary automatically. */
export async function uploadAvatar(file: File, upload?: UploadOptions) {
  const formData = new FormData();
  formData.append("file", file);

  return uploadRequest<MemberWithRoles>("/users/me/avatar", formData, upload);
}

export async function uploadWallpaper(file: File, upload?: UploadOptions) {
  const formData = new FormData();
  formData.append("file", file);

  return uploadRequest<{ wallpaper_url: string }>("/users/me/wallpaper", formData, upload);
}

export async function deleteWallpaper() {
  return apiClient<void>("/users/me/wallpaper", { method: "DELETE" });
}

export type StorageUsage = {
  bytes_used: number;
  quota_bytes: number;
};

export async function getStorageUsage() {
  return apiClient<StorageUsage>("/users/me/storage");
}
