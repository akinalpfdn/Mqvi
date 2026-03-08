/**
 * Profile API — profile update and avatar upload.
 *
 * Both endpoints return updated MemberWithRoles for immediate state sync.
 */

import { apiClient } from "./client";
import type { MemberWithRoles } from "../types";

type UpdateProfileRequest = {
  display_name?: string | null;
  custom_status?: string | null;
  language?: string;
};

export async function updateProfile(data: UpdateProfileRequest) {
  return apiClient<MemberWithRoles>("/users/me/profile", {
    method: "PATCH",
    body: data,
  });
}

/** Uploads avatar via multipart/form-data. Browser sets Content-Type with boundary automatically. */
export async function uploadAvatar(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  return apiClient<MemberWithRoles>("/users/me/avatar", {
    method: "POST",
    body: formData,
  });
}
