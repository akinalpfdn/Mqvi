/**
 * Auth API fonksiyonları — backend auth endpoint'leri ile iletişim.
 *
 * Her fonksiyon apiClient wrapper'ını kullanır.
 * Type parametreleri (<AuthTokens>) beklenen response tipini belirtir.
 */

import { apiClient } from "./client";
import type { AuthTokens, LoginRequest, RegisterRequest, User } from "../types";

/** Yeni kullanıcı kaydı. İlk kullanıcı otomatik Owner olur. */
export async function register(data: RegisterRequest) {
  return apiClient<AuthTokens>("/auth/register", {
    method: "POST",
    body: data,
  });
}

/** Kullanıcı girişi */
export async function login(data: LoginRequest) {
  return apiClient<AuthTokens>("/auth/login", {
    method: "POST",
    body: data,
  });
}

/** Access token yenileme */
export async function refreshToken(refresh_token: string) {
  return apiClient<{ access_token: string; refresh_token: string }>(
    "/auth/refresh",
    {
      method: "POST",
      body: { refresh_token },
    }
  );
}

/** Çıkış */
export async function logout(refresh_token: string) {
  return apiClient<{ message: string }>("/auth/logout", {
    method: "POST",
    body: { refresh_token },
  });
}

/** Mevcut kullanıcı bilgisi */
export async function getMe() {
  return apiClient<User>("/users/me");
}
