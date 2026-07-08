import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock heavy transitive deps before importing the store. api/client is intentionally
// NOT mocked: F4's fix reads the real token state (localStorage) after getMe fails, so
// the test must exercise the real getAccessToken/clearTokens against jsdom localStorage.
vi.mock("../api/auth", () => ({
  register: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  restoreAccount: vi.fn(),
  getMe: vi.fn(),
}));
vi.mock("./e2eeStore", () => ({
  useE2EEStore: { getState: () => ({ reset: vi.fn().mockResolvedValue(undefined) }) },
}));
vi.mock("./preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ fetchAndApply: vi.fn(), reset: vi.fn() }) },
}));
// Configurable voice state so a test can force the teardown path to throw.
const mockVoice = vi.hoisted(() => ({
  currentVoiceChannelId: null as string | null,
  leaveVoiceChannel: vi.fn(),
  _onLeaveCallback: null as (() => void) | null,
}));
vi.mock("./voiceStore", () => ({
  useVoiceStore: { getState: () => mockVoice },
}));
vi.mock("./settingsStore", () => ({
  useSettingsStore: { getState: () => ({ closeSettings: vi.fn() }) },
}));
vi.mock("../utils/pushToken", () => ({
  unregisterCurrentPushToken: vi.fn(),
  clearCachedPushToken: vi.fn(),
}));
vi.mock("../i18n", () => ({
  changeLanguage: vi.fn(),
  SUPPORTED_LANGUAGES: { en: true, tr: true },
}));

import { useAuthStore } from "./authStore";
import * as authApi from "../api/auth";
import { clearCachedPushToken } from "../utils/pushToken";
import type { User } from "../types";

const fakeUser = { id: "u1", username: "alice" } as unknown as User;
const getMe = vi.mocked(authApi.getMe);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mockVoice.currentVoiceChannelId = null;
  mockVoice._onLeaveCallback = null;
  useAuthStore.setState({ user: null, isInitialized: false, isLoading: false, error: null });
});

describe("authStore.initialize (F4 — offline/transient failure must not wipe the session)", () => {
  it("should keep tokens when getMe fails but the token is still present (network/5xx)", async () => {
    localStorage.setItem("access_token", "valid-token");
    localStorage.setItem("refresh_token", "valid-refresh");
    // Transient failure: the API layer preserves tokens on network/5xx, so they remain.
    getMe.mockResolvedValue({ success: false, error: "Network request failed" });

    await useAuthStore.getState().initialize();

    expect(localStorage.getItem("access_token")).toBe("valid-token");
    expect(localStorage.getItem("refresh_token")).toBe("valid-refresh");
    expect(clearCachedPushToken).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isInitialized).toBe(true);
  });

  it("should finalize logout cleanup when a genuine rejection already cleared the tokens", async () => {
    localStorage.setItem("access_token", "expired");
    // Simulate the real flow: getMe → refresh 401/403 → the API layer clears the tokens.
    getMe.mockImplementation(async () => {
      localStorage.removeItem("access_token");
      localStorage.removeItem("refresh_token");
      return { success: false, error: "unauthorized" };
    });

    await useAuthStore.getState().initialize();

    expect(localStorage.getItem("access_token")).toBeNull();
    expect(clearCachedPushToken).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isInitialized).toBe(true);
  });

  it("should short-circuit (no getMe) when there is no stored token", async () => {
    await useAuthStore.getState().initialize();

    expect(getMe).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isInitialized).toBe(true);
  });
});

describe("authStore.forceLogout (F5 — refresh rejection routes to login, idempotent)", () => {
  it("should clear the user and tokens", async () => {
    localStorage.setItem("access_token", "x");
    localStorage.setItem("refresh_token", "y");
    useAuthStore.setState({ user: fakeUser });

    await useAuthStore.getState().forceLogout();

    expect(useAuthStore.getState().user).toBeNull();
    expect(localStorage.getItem("access_token")).toBeNull();
    expect(localStorage.getItem("refresh_token")).toBeNull();
  });

  it("should still clear the user (kill the zombie) even if voice teardown throws", async () => {
    localStorage.setItem("access_token", "x");
    useAuthStore.setState({ user: fakeUser });
    mockVoice.currentVoiceChannelId = "chan1";
    mockVoice._onLeaveCallback = () => {
      throw new Error("WebRTC teardown blew up");
    };

    // Must not reject — the throw is contained so the critical teardown still runs.
    await expect(useAuthStore.getState().forceLogout()).resolves.toBeUndefined();

    // The route-to-login state is written despite the failed best-effort step.
    expect(useAuthStore.getState().user).toBeNull();
    expect(localStorage.getItem("access_token")).toBeNull();
  });

  it("should be idempotent — a second call when already logged out is a no-op", async () => {
    useAuthStore.setState({ user: fakeUser });
    await useAuthStore.getState().forceLogout();
    expect(useAuthStore.getState().user).toBeNull();

    // A token set after logout must NOT be cleared by a redundant forceLogout — proving
    // the "already logged out" guard short-circuits before touching tokens.
    localStorage.setItem("access_token", "late-token");
    await useAuthStore.getState().forceLogout();

    expect(useAuthStore.getState().user).toBeNull();
    expect(localStorage.getItem("access_token")).toBe("late-token");
  });
});
