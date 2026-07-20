/**
 * HTTP API client — all backend requests go through this module.
 *
 * Handles auth token injection, 401 refresh flow, and consistent error handling.
 */

import type { APIResponse } from "../types";
import { API_BASE_URL } from "../utils/constants";

function getAccessToken(): string | null {
  return localStorage.getItem("access_token");
}

function getRefreshToken(): string | null {
  return localStorage.getItem("refresh_token");
}

function setTokens(access: string, refresh: string, file: string): void {
  localStorage.setItem("access_token", access);
  localStorage.setItem("refresh_token", refresh);
  localStorage.setItem("file_token", file);
  void window.electronAPI?.setFileAuthToken(file, API_BASE_URL);
}

function clearTokens(): void {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
  localStorage.removeItem("file_token");
  void window.electronAPI?.clearFileAuthToken();
}

/**
 * Auth-rejection signal. Fired when a refresh is genuinely rejected (401/403) — the
 * session is unrecoverable. authStore registers a handler that tears the session down
 * and routes to login, so a dead token can't leave the UI in a zombie logged-in state
 * (F5). Kept as a module-level callback rather than importing authStore, to avoid a
 * circular dependency (authStore already imports the token helpers from this module).
 */
let onAuthRejected: (() => void) | null = null;

function setAuthRejectedHandler(handler: (() => void) | null): void {
  onAuthRejected = handler;
}

/**
 * Refreshes an expired access token using the refresh token.
 *
 * Uses a shared promise lock to prevent multiple concurrent refresh requests.
 * Without this, parallel 401s would each try to refresh, invalidating each other's
 * tokens and causing unexpected logouts.
 */
let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = doRefresh();
  try {
    return await refreshPromise;
  } finally {
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
      // Honor the rotated file-serve cookie that /auth/refresh sets.
      credentials: "include",
    });

    if (!res.ok) {
      // Only clear tokens on explicit auth rejection — 5xx/429/network errors
      // don't mean the token is invalid, just that the server/network failed.
      if (res.status === 401 || res.status === 403) {
        console.warn(`[apiClient] refresh endpoint returned ${res.status} — CLEARING TOKENS`, {
          timestamp: new Date().toISOString(),
        });
        clearTokens();
        // Genuine rejection — notify authStore to tear down the session and route to
        // login. Only on 401/403 (never 5xx/network), so a transient blip can't force
        // a logout. Idempotent on the receiver, so parallel 401s are safe.
        onAuthRejected?.();
      } else {
        console.warn(`[apiClient] refresh endpoint returned ${res.status} — tokens preserved`);
      }
      return false;
    }

    const data: APIResponse<{ access_token: string; refresh_token: string; file_token: string }> =
      await res.json();

    if (data.success && data.data) {
      setTokens(data.data.access_token, data.data.refresh_token, data.data.file_token);
      return true;
    }

    return false;
  } catch {
    // Network error (timeout, DNS, offline) — tokens may still be valid, don't clear.
    return false;
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/**
 * Core HTTP request function. Generic type <T> specifies the expected response data type.
 *
 * Usage:
 *   const data = await apiClient<User[]>("/users");
 *   const user = await apiClient<User>("/users/me", { method: "PATCH", body: { display_name: "New" } });
 */
export async function apiClient<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<APIResponse<T>> {
  const { method = "GET", body, headers: extraHeaders, signal } = options;

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
    // Send/receive the file-serve session cookie set by /auth/* endpoints.
    // Same-origin web defaults to "include"; this explicit value is required
    // for the Electron renderer (file:// origin → API is cross-site).
    credentials: "include",
    signal,
  };

  if (body) {
    fetchOptions.body =
      body instanceof FormData ? body : JSON.stringify(body);
  }

  let res: Response;

  try {
    res = await fetch(`${API_BASE_URL}${endpoint}`, fetchOptions);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Network request failed";
    console.error(`[apiClient] ${method} ${endpoint}:`, message);
    return { success: false, error: message } as APIResponse<T>;
  }

  // 401 — attempt token refresh
  if (res.status === 401 && getRefreshToken()) {
    console.warn(`[apiClient] 401 on ${method} ${endpoint} — attempting refresh`, {
      timestamp: new Date().toISOString(),
      hadAuthHeader: !!token,
    });
    const refreshed = await refreshAccessToken();
    console.warn(`[apiClient] refresh result: ${refreshed}`, {
      hasAccessTokenAfter: !!getAccessToken(),
      hasRefreshTokenAfter: !!getRefreshToken(),
    });
    if (refreshed) {
      headers["Authorization"] = `Bearer ${getAccessToken()}`;
      try {
        res = await fetch(`${API_BASE_URL}${endpoint}`, {
          ...fetchOptions,
          headers,
        });
        console.warn(`[apiClient] retry after refresh: ${method} ${endpoint} status=${res.status}`);
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Network request failed";
        console.error(`[apiClient] ${method} ${endpoint} (retry):`, message);
        return { success: false, error: message } as APIResponse<T>;
      }
    } else {
      console.warn(`[apiClient] refresh FAILED on ${method} ${endpoint} — returning original 401`);
    }
  } else if (res.status === 401) {
    console.warn(`[apiClient] 401 on ${method} ${endpoint} but NO refresh_token in storage`, {
      hadAuthHeader: !!token,
    });
  }

  // 204 No Content — no body to parse
  if (res.status === 204) {
    return { success: true, data: undefined as T };
  }

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

/** `code` on an APIResponse whose upload the caller cancelled — not a failure, stay silent. */
const UPLOAD_ABORTED = "UPLOAD_ABORTED";

type UploadOptions = {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** `total` is null when the browser cannot compute the body length. */
  onProgress?: (loaded: number, total: number | null) => void;
};

type XhrResult<T> = { status: number; response: APIResponse<T> };

function sendXhr<T>(
  endpoint: string,
  body: FormData,
  method: string,
  extraHeaders: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
  onProgress: UploadOptions["onProgress"],
  token: string | null
): Promise<XhrResult<T>> {
  return new Promise((resolve) => {
    const aborted: XhrResult<T> = {
      status: 0,
      response: { success: false, error: "Upload cancelled", code: UPLOAD_ABORTED },
    };
    if (signal?.aborted) {
      resolve(aborted);
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open(method, `${API_BASE_URL}${endpoint}`);
    // Matches apiClient's credentials:"include" — the file-serve cookie must ride along, and the
    // Electron renderer's file:// origin makes every API call cross-site.
    xhr.withCredentials = true;

    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    for (const [key, value] of Object.entries(extraHeaders ?? {})) {
      xhr.setRequestHeader(key, value);
    }
    // Content-Type is left unset on purpose: the browser derives it from the FormData, including
    // the multipart boundary. Setting it by hand produces a body the server cannot parse.

    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort);
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    let lastTotal: number | null = null;
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        lastTotal = e.lengthComputable ? e.total : null;
        onProgress(e.loaded, lastTotal);
      };
    }

    xhr.onload = () => {
      cleanup();
      // The last upload.onprogress can land below total; settle the bar so it never sticks at 99%.
      if (onProgress && lastTotal !== null) onProgress(lastTotal, lastTotal);

      if (xhr.status === 204) {
        resolve({ status: 204, response: { success: true, data: undefined as T } });
        return;
      }
      try {
        resolve({ status: xhr.status, response: JSON.parse(xhr.responseText) as APIResponse<T> });
      } catch {
        // Non-JSON body — a proxy rejection (Cloudflare 413) or a crash page.
        console.error(`[upload] ${method} ${endpoint}: invalid JSON (HTTP ${xhr.status})`);
        resolve({
          status: xhr.status,
          response: { success: false, error: `HTTP ${xhr.status}: ${xhr.statusText}` },
        });
      }
    };

    xhr.onerror = () => {
      cleanup();
      console.error(`[upload] ${method} ${endpoint}: network error`);
      resolve({ status: 0, response: { success: false, error: "Network request failed" } });
    };

    xhr.onabort = () => {
      cleanup();
      resolve(aborted);
    };

    xhr.send(body);
  });
}

/**
 * Multipart upload transport. Mirrors apiClient's auth behaviour — Bearer header, credentials,
 * one 401 refresh + retry, same APIResponse envelope — but runs on XMLHttpRequest because the
 * Fetch API cannot report upload progress and cannot be cancelled mid-transfer.
 */
async function uploadRequest<T>(
  endpoint: string,
  body: FormData,
  options: UploadOptions = {}
): Promise<APIResponse<T>> {
  const { method = "POST", headers, signal, onProgress } = options;

  const first = await sendXhr<T>(endpoint, body, method, headers, signal, onProgress, getAccessToken());
  if (first.status !== 401 || !getRefreshToken()) return first.response;

  const refreshed = await refreshAccessToken();
  if (!refreshed) return first.response;

  // FormData is replayable, so the retry re-sends the same body. Progress restarts from zero.
  const retry = await sendXhr<T>(endpoint, body, method, headers, signal, onProgress, getAccessToken());
  return retry.response;
}

/**
 * Checks if a JWT access token is expired.
 * Includes a 10s buffer so tokens about to expire are treated as expired,
 * preventing requests that expire mid-transport.
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
 * Ensures a valid access token exists, refreshing if needed.
 *
 * Used before WebSocket connections — unlike HTTP requests, WS connections
 * don't return 401 on expired tokens, they just get rejected, causing
 * infinite reconnect loops.
 */
async function ensureFreshToken(): Promise<string | null> {
  const token = getAccessToken();
  if (!token) return null;

  if (!isTokenExpired(token)) return token;

  const refreshed = await refreshAccessToken();
  if (!refreshed) return null;

  return getAccessToken();
}

export {
  setTokens,
  clearTokens,
  getAccessToken,
  ensureFreshToken,
  setAuthRejectedHandler,
  uploadRequest,
  UPLOAD_ABORTED,
};
export type { UploadOptions };
