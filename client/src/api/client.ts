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
 *
 * Race condition koruması:
 * Birden fazla istek aynı anda 401 alırsa, hepsi refreshAccessToken() çağırır.
 * İlk çağrı refresh endpoint'ine gider ve eski refresh token'ı invalidate eder.
 * Eğer diğer istekler de ayrı ayrı refresh yapsa, eski (artık geçersiz) token'la
 * giderler → fail → clearTokens() → kullanıcı beklenmedik şekilde logout olur.
 *
 * Çözüm: refreshPromise lock. İlk 401 gerçek refresh isteğini başlatır,
 * sonraki 401'ler aynı promise'i bekler. Refresh tamamlanınca (başarılı veya
 * başarısız) promise sıfırlanır ve hepsi yeni token'la retry eder.
 */
let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  // Zaten bir refresh devam ediyorsa, onu bekle — ikinci istek yapmadan
  if (refreshPromise) return refreshPromise;

  refreshPromise = doRefresh();
  try {
    return await refreshPromise;
  } finally {
    // Tamamlanınca lock'u serbest bırak — sonraki 401'ler yeni refresh başlatabilsin
    refreshPromise = null;
  }
}

async function doRefresh(): Promise<boolean> {
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

/**
 * isTokenExpired — JWT access token'ın süresinin dolup dolmadığını kontrol eder.
 *
 * JWT yapısı: header.payload.signature (base64 encoded, nokta ile ayrılmış)
 * Payload içindeki "exp" alanı token'ın geçerlilik bitiş zamanını (Unix timestamp) tutar.
 *
 * 10 saniyelik buffer: Token 10 saniye içinde expire olacaksa da "expired" sayılır.
 * Bu, tam son anda gönderilen isteklerin transport sırasında expire olmasını önler.
 */
function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp * 1000 < Date.now() + 10_000;
  } catch {
    return true;
  }
}

/**
 * ensureFreshToken — Geçerli bir access token olduğundan emin ol.
 *
 * WebSocket reconnect'te kullanılır: bağlanmadan önce token'ın expire olup
 * olmadığını kontrol eder, expire olduysa refresh token ile yeniler.
 *
 * HTTP istekleri için bu gerekmez — apiClient zaten 401'de refresh yapar.
 * Ama WebSocket bağlantısında 401 dönmez, sadece connection reject edilir
 * ve onclose tetiklenir. Bu da sonsuz reconnect döngüsüne yol açar:
 * expired token → reject → onclose → reconnect → expired token → ...
 *
 * @returns Taze access token veya null (refresh de başarısızsa)
 */
async function ensureFreshToken(): Promise<string | null> {
  const token = getAccessToken();
  if (!token) return null;

  if (!isTokenExpired(token)) return token;

  // Token expired veya expire olmak üzere — refresh yap
  const refreshed = await refreshAccessToken();
  if (!refreshed) return null;

  return getAccessToken();
}

export { setTokens, clearTokens, getAccessToken, ensureFreshToken };
