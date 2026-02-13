/**
 * Server API fonksiyonları — sunucu bilgisi okuma ve güncelleme.
 *
 * getServer: GET /api/server — sunucu bilgisi (isim, ikon)
 * updateServer: PATCH /api/server — sunucu adı güncelleme (Admin)
 * uploadServerIcon: POST /api/server/icon — sunucu ikonu yükleme (Admin)
 */

import { apiClient } from "./client";
import type { Server } from "../types";

/** Sunucu bilgisini al */
export async function getServer() {
  return apiClient<Server>("/server");
}

/** Sunucu bilgisini güncelle (isim, invite_required) */
export async function updateServer(data: { name?: string; invite_required?: boolean }) {
  return apiClient<Server>("/server", {
    method: "PATCH",
    body: data,
  });
}

/** Sunucu ikonu yükle — multipart/form-data */
export async function uploadServerIcon(file: File) {
  const formData = new FormData();
  formData.append("file", file);

  return apiClient<Server>("/server/icon", {
    method: "POST",
    body: formData,
  });
}
