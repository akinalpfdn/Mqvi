/**
 * HTTP API client — tüm backend istekleri bu modül üzerinden yapılır.
 *
 * Neden fetch wrapper?
 * - Her istekte Authorization header otomatik eklenir
 * - 401 geldiğinde refresh token ile yenileme dener
 * - Tutarlı error handling
 * - Type-safe response parsing
 */

import type { APIResponse } from "../types";
import { API_BASE_URL } from "../utils/constants";

/**
 * Token'ları localStorage'da tutar.
 * Zustand store hazır olduğunda oradan da erişilebilir,
 * ama API client'ın store'a bağımlı olmaması için burada da erişim var.
 */
function getAccessToken(): string | null {
  return localStorage.getItem("access_token");
}

function getRefreshToken(): string | null {
  return localStorage.getItem("refresh_token");
}

function setTokens(access: string, refresh: string): void {
  localStorage.setItem("access_token", access);
  localStorage.setItem("refresh_token", refresh);
}

function clearTokens(): void {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
}

/**
 * refreshAccessToken — Süresi dolmuş access token'ı yenilemek için
 * refresh token ile backend'e istek atar.
 */
async function refreshAccessToken(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) {
      clearTokens();
      return false;
    }

    const data: APIResponse<{ access_token: string; refresh_token: string }> =
      await res.json();

    if (data.success && data.data) {
      setTokens(data.data.access_token, data.data.refresh_token);
      return true;
    }

    clearTokens();
    return false;
  } catch {
    clearTokens();
    return false;
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

/**
 * apiClient — Temel HTTP istek fonksiyonu.
 *
 * Kullanım:
 *   const data = await apiClient<User[]>("/users");
 *   const user = await apiClient<User>("/users/me", { method: "PATCH", body: { display_name: "Yeni Ad" } });
 *
 * Generic tip <T>, beklenen response data tipini belirtir — TypeScript bu sayede
 * dönen verinin tipini bilir ve yanlış kullanımda derleme hatası verir.
 */
export async function apiClient<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<APIResponse<T>> {
  const { method = "GET", body, headers: extraHeaders } = options;

  const headers: Record<string, string> = {
    ...extraHeaders,
  };

  const token = getAccessToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (body) {
    fetchOptions.body =
      body instanceof FormData ? body : JSON.stringify(body);
  }

  let res: Response;

  try {
    res = await fetch(`${API_BASE_URL}${endpoint}`, fetchOptions);
  } catch (err) {
    // Network hatası, DNS çözülemedi, TLS hatası, CORS reject vb.
    const message =
      err instanceof Error ? err.message : "Network request failed";
    console.error(`[apiClient] ${method} ${endpoint}:`, message);
    return { success: false, error: message } as APIResponse<T>;
  }

  // 401 Unauthorized → refresh token ile yenilemeyi dene
  if (res.status === 401 && getRefreshToken()) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers["Authorization"] = `Bearer ${getAccessToken()}`;
      try {
        res = await fetch(`${API_BASE_URL}${endpoint}`, {
          ...fetchOptions,
          headers,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Network request failed";
        console.error(`[apiClient] ${method} ${endpoint} (retry):`, message);
        return { success: false, error: message } as APIResponse<T>;
      }
    }
  }

  // JSON parse hatası koruması (sunucu beklenmeyen yanıt dönerse)
  try {
    const data: APIResponse<T> = await res.json();
    return data;
  } catch {
    console.error(`[apiClient] ${method} ${endpoint}: invalid JSON (HTTP ${res.status})`);
    return {
      success: false,
      error: `HTTP ${res.status}: ${res.statusText}`,
    } as APIResponse<T>;
  }
}

export { setTokens, clearTokens, getAccessToken };
