/**
 * Auth API — authentication endpoints.
 */

import { apiClient } from "./client";
import type { AuthTokens, LoginRequest, RegisterRequest, User } from "../types";

/** Register a new user. First user automatically becomes Owner. */
export async function register(data: RegisterRequest) {
  return apiClient<AuthTokens>("/auth/register", {
    method: "POST",
    body: data,
  });
}

export async function login(data: LoginRequest) {
  return apiClient<AuthTokens>("/auth/login", {
    method: "POST",
    body: data,
  });
}

export async function refreshToken(refresh_token: string) {
  return apiClient<{ access_token: string; refresh_token: string }>(
    "/auth/refresh",
    {
      method: "POST",
      body: { refresh_token },
    }
  );
}

export async function logout(refresh_token: string) {
  return apiClient<{ message: string }>("/auth/logout", {
    method: "POST",
    body: { refresh_token },
  });
}

export async function getMe() {
  return apiClient<User>("/users/me");
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
) {
  return apiClient<{ message: string }>("/users/me/password", {
    method: "POST",
    body: { current_password: currentPassword, new_password: newPassword },
  });
}

/** Sends a password reset email. Returns cooldown seconds if rate-limited. */
export async function forgotPassword(email: string) {
  return apiClient<{ message: string; cooldown?: number }>(
    "/auth/forgot-password",
    {
      method: "POST",
      body: { email },
    },
  );
}

export async function resetPassword(token: string, newPassword: string) {
  return apiClient<{ message: string }>("/auth/reset-password", {
    method: "POST",
    body: { token, new_password: newPassword },
  });
}

/** Mark download prompt as seen — never show again across devices. */
export async function dismissDownloadPrompt() {
  return apiClient<{ message: string }>("/users/me/dismiss-download-prompt", {
    method: "POST",
  });
}

/** Mark welcome modal as seen — never show again across devices. */
export async function dismissWelcome() {
  return apiClient<{ message: string }>("/users/me/dismiss-welcome", {
    method: "POST",
  });
}

/** Change email — requires current password for security. */
export async function changeEmail(password: string, newEmail: string) {
  return apiClient<{ message: string; email: string | null }>(
    "/users/me/email",
    {
      method: "PUT",
      body: { password, new_email: newEmail },
    },
  );
}
