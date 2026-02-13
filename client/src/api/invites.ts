/**
 * Invites API fonksiyonları — davet kodu CRUD endpoint'leri.
 *
 * getInvites: GET /api/invites — davet listesi
 * createInvite: POST /api/invites — yeni davet oluştur
 * deleteInvite: DELETE /api/invites/{code} — davet sil
 *
 * Tüm endpoint'ler ManageInvites yetkisi gerektirir.
 */

import { apiClient } from "./client";
import type { Invite } from "../types";

/** Tüm davet kodlarını listele */
export async function getInvites() {
  return apiClient<Invite[]>("/invites");
}

/** Yeni davet kodu oluştur */
export async function createInvite(data: {
  max_uses: number;
  expires_in: number;
}) {
  return apiClient<Invite>("/invites", {
    method: "POST",
    body: data,
  });
}

/** Davet kodunu sil */
export async function deleteInvite(code: string) {
  return apiClient<{ message: string }>(`/invites/${code}`, {
    method: "DELETE",
  });
}
