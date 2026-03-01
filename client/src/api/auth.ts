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

/** Şifre değiştirme — mevcut şifre doğrulandıktan sonra yeni şifre set eder */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
) {
  return apiClient<{ message: string }>("/users/me/password", {
    method: "POST",
    body: { current_password: currentPassword, new_password: newPassword },
  });
}

/** Şifre sıfırlama emaili gönderir. cooldown > 0 ise kalan saniye döner. */
export async function forgotPassword(email: string) {
  return apiClient<{ message: string; cooldown?: number }>(
    "/auth/forgot-password",
    {
      method: "POST",
      body: { email },
    },
  );
}

/** Token ile şifre sıfırlar */
export async function resetPassword(token: string, newPassword: string) {
  return apiClient<{ message: string }>("/auth/reset-password", {
    method: "POST",
    body: { token, new_password: newPassword },
  });
}

/** Email değiştirme/kaldırma — güvenlik gereği mevcut şifre doğrulaması gerekir */
export async function changeEmail(password: string, newEmail: string) {
  return apiClient<{ message: string; email: string | null }>(
    "/users/me/email",
    {
      method: "PUT",
      body: { password, new_email: newEmail },
    },
  );
}
