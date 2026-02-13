/**
 * Profile API fonksiyonları — profil güncelleme ve avatar yükleme.
 *
 * updateProfile: PATCH /api/users/me/profile — display_name, custom_status, language
 * uploadAvatar: POST /api/users/me/avatar — multipart/form-data ile resim dosyası
 *
 * Her iki endpoint de güncellenmiş MemberWithRoles döner —
 * bu sayede frontend'de user state anında güncellenebilir.
 */

import { apiClient } from "./client";
import type { MemberWithRoles } from "../types";

/** Profil güncelleme request'i — partial update (göndermediğin field değişmez) */
type UpdateProfileRequest = {
  display_name?: string | null;
  custom_status?: string | null;
  language?: string;
};

/** Kullanıcı profilini güncelle (display name, custom status, language) */
export async function updateProfile(data: UpdateProfileRequest) {
  return apiClient<MemberWithRoles>("/users/me/profile", {
    method: "PATCH",
    body: data,
  });
}

/**
 * Avatar yükle — multipart/form-data ile resim dosyası gönderir.
 *
 * FormData kullanımı:
 * apiClient body olarak FormData aldığında Content-Type header'ını
 * otomatik olarak AYARLAMAZ — tarayıcı boundary'yi kendisi ekler.
 * Bu davranış client.ts'de kontrol ediliyor (body instanceof FormData kontrolü).
 */
export async function uploadAvatar(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  return apiClient<MemberWithRoles>("/users/me/avatar", {
    method: "POST",
    body: formData,
  });
}
