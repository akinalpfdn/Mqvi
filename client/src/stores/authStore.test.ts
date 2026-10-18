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
  default: { language: "en" },
  changeLanguage: vi.fn(),
  resolveLanguage: () => "en",
  SUPPORTED_LANGUAGES: { en: true, tr: true },
}));

import { useAuthStore, hasSignedInBefore } from "./authStore";
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
  useAuthStore.setState({
    user: null,
    isInitialized: false,
    isServerUnreachable: false,
    isLoading: false,
    error: null,
  });
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

describe("authStore.initialize — a stored session the server cannot confirm yet", () => {
  beforeEach(() => {
    localStorage.setItem("access_token", "valid-token");
    localStorage.setItem("refresh_token", "valid-refresh");
  });

  it.each([
    ["no response", 0],
    ["a server error", 503],
    ["rate limiting", 429],
  ])("should show connecting, not login, when getMe gets %s", async (_name, httpStatus) => {
    getMe.mockResolvedValue({ success: false, error: "x", httpStatus });

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().isServerUnreachable).toBe(true);
    expect(useAuthStore.getState().user).toBeNull();
    expect(localStorage.getItem("refresh_token")).toBe("valid-refresh");
  });

  it("should show login when the refresh was rejected", async () => {
    getMe.mockImplementation(async () => {
      localStorage.removeItem("access_token");
      localStorage.removeItem("refresh_token");
      return { success: false, error: "unauthorized", httpStatus: 401 };
    });

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().isServerUnreachable).toBe(false);
  });

  it("should sign in and leave connecting when a retry reaches the server", async () => {
    getMe.mockResolvedValueOnce({ success: false, error: "x", httpStatus: 0 });
    await useAuthStore.getState().initialize();
    getMe.mockResolvedValueOnce({ success: true, data: fakeUser, httpStatus: 200 });

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().isServerUnreachable).toBe(false);
    expect(useAuthStore.getState().user).toEqual(fakeUser);
  });

  it("should make one attempt when retries fire at the same time", async () => {
    getMe.mockResolvedValue({ success: false, error: "x", httpStatus: 0 });

    await Promise.all([
      useAuthStore.getState().initialize(),
      useAuthStore.getState().initialize(),
      useAuthStore.getState().initialize(),
    ]);

    expect(getMe).toHaveBeenCalledTimes(1);
  });
});

describe("authStore.abandonSession — signing out while the server is unreachable", () => {
  const logout = vi.mocked(authApi.logout);

  it("should clear the session locally and queue the server logout", () => {
    localStorage.setItem("access_token", "a");
    localStorage.setItem("refresh_token", "sid.secret");
    useAuthStore.setState({ isServerUnreachable: true });

    useAuthStore.getState().abandonSession();

    expect(localStorage.getItem("access_token")).toBeNull();
    expect(localStorage.getItem("refresh_token")).toBeNull();
    expect(localStorage.getItem("mqvi_pending_logout")).toBe("sid.secret");
    expect(useAuthStore.getState().isServerUnreachable).toBe(false);
  });

  it("should send the queued logout on the next boot and forget it once the server answers", async () => {
    localStorage.setItem("mqvi_pending_logout", "sid.secret");
    logout.mockResolvedValue({ success: true, httpStatus: 200 } as Awaited<ReturnType<typeof authApi.logout>>);

    await useAuthStore.getState().initialize();
    await vi.waitFor(() => expect(localStorage.getItem("mqvi_pending_logout")).toBeNull());

    expect(logout).toHaveBeenCalledWith("sid.secret");
  });

  it("should keep the queued logout while the server is still unreachable", async () => {
    localStorage.setItem("mqvi_pending_logout", "sid.secret");
    logout.mockResolvedValue({ success: false, error: "offline", httpStatus: 0 } as Awaited<ReturnType<typeof authApi.logout>>);

    await useAuthStore.getState().initialize();
    await vi.waitFor(() => expect(logout).toHaveBeenCalled());

    expect(localStorage.getItem("mqvi_pending_logout")).toBe("sid.secret");
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

describe("the greeting on the login screen", () => {
  const signedIn = { access_token: "a", refresh_token: "r", file_token: "f", user: fakeUser };

  it("is not 'welcome back' on a device that has never signed in", () => {
    expect(hasSignedInBefore()).toBe(false);
  });

  it("becomes 'welcome back' after a sign-in and stays so after logging out", async () => {
    vi.mocked(authApi.login).mockResolvedValue({ success: true, data: signedIn } as Awaited<ReturnType<typeof authApi.login>>);
    vi.mocked(authApi.logout).mockResolvedValue({ success: true } as Awaited<ReturnType<typeof authApi.logout>>);

    await useAuthStore.getState().login("alice", "pw");
    await useAuthStore.getState().logout();

    expect(hasSignedInBefore()).toBe(true);
  });

  it("counts a new account as a sign-in", async () => {
    vi.mocked(authApi.register).mockResolvedValue({ success: true, data: signedIn } as Awaited<ReturnType<typeof authApi.register>>);

    await useAuthStore.getState().register("alice", "pw", "Alice");

    expect(hasSignedInBefore()).toBe(true);
  });
});

describe("signing out closes what the guide had open", () => {
  it("ends a tour in progress and closes the guide tab", async () => {
    const { useSpotlightStore } = await import("./spotlightStore");
    const { useUIStore } = await import("./uiStore");
    const { GUIDE_TAB_ID } = await import("../utils/guideScript");
    vi.mocked(authApi.logout).mockResolvedValue({ success: true } as Awaited<ReturnType<typeof authApi.logout>>);
    useSpotlightStore.getState().open({ step: "friend", scope: "friend", stages: [{ target: "friends" }] });
    useUIStore.getState().openTab(GUIDE_TAB_ID, "guide", "guide");

    await useAuthStore.getState().logout();

    expect(useSpotlightStore.getState().tour).toBeNull();
    const tabs = Object.values(useUIStore.getState().panels).flatMap((p) => p.tabs);
    expect(tabs.some((tb) => tb.channelId === GUIDE_TAB_ID)).toBe(false);
  });
});
