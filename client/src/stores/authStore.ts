/**
 * Auth Store — User session management.
 */

import { create } from "zustand";
import * as authApi from "../api/auth";
import * as profileApi from "../api/profile";
import { passwordErrorMessage } from "../utils/passwordError";
import {
  setTokens,
  clearTokens,
  getAccessToken,
  getRefreshToken,
  isTransientStatus,
  setAuthRejectedHandler,
} from "../api/client";
import { API_BASE_URL } from "../utils/constants";
import i18n, { changeLanguage, resolveLanguage, type Language, SUPPORTED_LANGUAGES } from "../i18n";
import { useE2EEStore } from "./e2eeStore";
import { usePreferencesStore } from "./preferencesStore";
import { useGuideStore } from "./guideStore";
import { useSpotlightStore } from "./spotlightStore";
import { useUIStore } from "./uiStore";
import { GUIDE_TAB_ID } from "../utils/guideScript";
import { useVoiceStore } from "./voiceStore";
import { endP2PCallForLogout } from "./shared/p2pCallControl";
import { useSettingsStore } from "./settingsStore";
import { unregisterCurrentPushToken, clearCachedPushToken } from "../utils/pushToken";
import { resetMarkReadTracking } from "./shared/markReadTracking";
import type { User, UserStatus } from "../types";

const MANUAL_STATUS_KEY = "mqvi_manual_status";
/** Set on this device's first sign-in and kept through logout: the login screen greets accordingly. */
const SIGNED_IN_BEFORE_KEY = "mqvi_signed_in_before";

export function hasSignedInBefore(): boolean {
  return localStorage.getItem(SIGNED_IN_BEFORE_KEY) === "1";
}

/** A tour and the guide tab belong to the account that opened them, not the next one. */
function closeGuideSurfaces(): void {
  useSpotlightStore.getState().close();
  const ui = useUIStore.getState();
  for (const panel of Object.values(ui.panels)) {
    const tab = panel.tabs.find((tb) => tb.channelId === GUIDE_TAB_ID);
    if (tab) ui.closeTab(panel.id, tab.id);
  }
}

function rememberSignIn(): void {
  localStorage.setItem(SIGNED_IN_BEFORE_KEY, "1");
}

/**
 * A refresh token whose logout could not reach the server. Kept until it can, so the server-side
 * session (and the device's push registration with it) does not outlive a sign-out made offline.
 */
const PENDING_LOGOUT_KEY = "mqvi_pending_logout";

async function flushPendingLogout(): Promise<void> {
  const pending = localStorage.getItem(PENDING_LOGOUT_KEY);
  if (!pending) return;
  const res = await authApi.logout(pending);
  if (res.success || !isTransientStatus(res.httpStatus)) {
    localStorage.removeItem(PENDING_LOGOUT_KEY);
  }
}

/** One boot attempt at a time: the retry timer, the online event and the button can all fire it. */
let initializeInFlight: Promise<void> | null = null;

/** Apply user's DB language preference to i18n (takes priority over browser locale). */
function syncLanguageFromUser(user: User): void {
  if (user.language && user.language in SUPPORTED_LANGUAGES) {
    changeLanguage(user.language as Language);
    return;
  }

  // TEMPORARY — delete once no account has an empty language.
  //
  // Registration used to leave users.language as "", so the app ran on the browser locale
  // while the profile picker and every push notification still said English — and the
  // backend rejected every profile save, since "" is not a language it knows. A migration to
  // "en" would have flipped those users to English instead of fixing them, so each one adopts
  // what it is already showing, on next sign-in. Nothing writes "" any more, so this branch
  // stops firing on its own; drop it when the column has no empty values left.
  const detected = resolveLanguage(i18n.language);
  void profileApi.updateProfile({ language: detected });
  // The caller stores this object verbatim, so correct it here too — otherwise the session
  // runs with a language the server no longer has.
  user.language = detected;
}

/**
 * AccountDeletedInfo — populated when login is attempted on a soft-deleted account.
 * Frontend reads this to show the recovery modal.
 */
export type AccountDeletedInfo = {
  username: string;
  deletedAt: string;
  permanentDeleteAt: string;
  /** The password the user just typed in the login form, reused for restore. */
  password: string;
};

type AuthState = {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  isInitialized: boolean;
  /** A session is stored but the server could not be reached to resume it. Not signed out. */
  isServerUnreachable: boolean;
  accountDeleted: AccountDeletedInfo | null;

  // ─── Actions ───
  register: (username: string, password: string, displayName?: string, email?: string) => Promise<boolean>;
  login: (username: string, password: string) => Promise<boolean>;
  /** Restore a soft-deleted account using captured username + password. Returns true on success. */
  restoreAccount: () => Promise<boolean>;
  /** Dismiss the account-deleted recovery prompt without restoring. */
  cancelAccountDeleted: () => void;
  logout: () => Promise<void>;
  /**
   * Force-logout triggered when the refresh token is rejected server-side (401/403).
   * Local teardown only (tokens are already invalid, so no server logout / push
   * unregister) + routes to login by clearing user. Idempotent.
   */
  forceLogout: () => Promise<void>;
  initialize: () => Promise<void>;
  /**
   * Sign out while the server is unreachable: local state goes now, the server-side logout is
   * queued and sent on the next successful contact.
   */
  abandonSession: () => void;
  clearError: () => void;
  updateUser: (partial: Partial<User>) => void;
  replaceTokens: (access: string, refresh: string, file: string) => void;

  /**
   * User's manually selected presence. When set to "online", idle detection works normally.
   * When "dnd"/"idle"/"offline" (invisible), idle detection is disabled to preserve the choice.
   * Persisted in DB (pref_status column). localStorage is a local cache for UI before WS connects.
   * Authoritative value comes from server via ready event.
   */
  manualStatus: UserStatus;
  setManualStatus: (status: UserStatus) => void;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isLoading: false,
  error: null,
  isInitialized: false,
  isServerUnreachable: false,
  accountDeleted: null,
  manualStatus: (localStorage.getItem(MANUAL_STATUS_KEY) as UserStatus) || "online",

  register: async (username, password, displayName, email) => {
    set({ isLoading: true, error: null });

    const res = await authApi.register({
      username,
      password,
      display_name: displayName,
      email: email || undefined,
      // Whatever the sign-up screen was already in — the account should agree with it.
      language: resolveLanguage(i18n.language),
    });

    if (res.success && res.data) {
      setTokens(res.data.access_token, res.data.refresh_token, res.data.file_token);
      rememberSignIn();
      syncLanguageFromUser(res.data.user);
      set({ user: res.data.user, isLoading: false });
      usePreferencesStore.getState().fetchAndApply();
      return true;
    }

    set({ error: passwordErrorMessage(res, "auth:registerFailed"), isLoading: false });
    return false;
  },

  login: async (username, password) => {
    set({ isLoading: true, error: null, accountDeleted: null });

    const res = await authApi.login({ username, password });

    if (res.success && res.data) {
      setTokens(res.data.access_token, res.data.refresh_token, res.data.file_token);
      rememberSignIn();
      syncLanguageFromUser(res.data.user);
      set({ user: res.data.user, isLoading: false });
      // Fetch server-side preferences and apply to stores
      usePreferencesStore.getState().fetchAndApply();
      void flushPendingLogout();
      return true;
    }

    // Soft-deleted account: backend returns { success: false, error: "account_deleted",
    // data: { username, deleted_at, permanent_delete_at } } with HTTP 403.
    if (res.error === "account_deleted" && res.data) {
      const info = res.data as unknown as {
        username: string;
        deleted_at: string;
        permanent_delete_at: string;
      };
      set({
        accountDeleted: {
          username: info.username,
          deletedAt: info.deleted_at,
          permanentDeleteAt: info.permanent_delete_at,
          password,
        },
        isLoading: false,
        error: null,
      });
      return false;
    }

    set({ error: res.error ?? "Login failed", isLoading: false });
    return false;
  },

  restoreAccount: async () => {
    const info = get().accountDeleted;
    if (!info) return false;

    set({ isLoading: true, error: null });
    const res = await authApi.restoreAccount(info.username, info.password);

    if (res.success && res.data) {
      setTokens(res.data.access_token, res.data.refresh_token, res.data.file_token);
      rememberSignIn();
      syncLanguageFromUser(res.data.user);
      set({ user: res.data.user, isLoading: false, accountDeleted: null });
      usePreferencesStore.getState().fetchAndApply();
      return true;
    }

    set({ error: res.error ?? "Restore failed", isLoading: false });
    return false;
  },

  cancelAccountDeleted: () => set({ accountDeleted: null }),

  logout: async () => {
    // End any call: its screen goes with the session, and nothing else would stop the
    // microphone it holds. Isolated so a failing teardown cannot stop the logout itself.
    try {
      endP2PCallForLogout();
    } catch (err) {
      console.error("[authStore] logout: call teardown failed", err);
    }

    // Leave voice channel first
    const voiceState = useVoiceStore.getState();
    if (voiceState.currentVoiceChannelId) {
      if (voiceState._onLeaveCallback) {
        voiceState._onLeaveCallback();
      } else {
        voiceState.leaveVoiceChannel();
      }
    }

    // Reset E2EE state (IndexedDB keys preserved)
    await useE2EEStore.getState().reset();
    usePreferencesStore.getState().reset();
    useGuideStore.getState().reset();
    closeGuideSurfaces();
    // The SPA does not reload between logout and login: without this the next user inherits
    // this one's mark-read dedupe state and their DM badges never clear.
    resetMarkReadTracking();

    // Unregister this device's push token while the access token is still valid.
    await unregisterCurrentPushToken();

    const refreshToken = localStorage.getItem("refresh_token");
    if (refreshToken) {
      await authApi.logout(refreshToken);
    }
    clearTokens();
    // Close settings modal if open (SPA doesn't reload between logout → login)
    useSettingsStore.getState().closeSettings();
    set({ user: null });
  },

  forceLogout: async () => {
    // The refresh token was rejected (401/403): the session is dead server-side and the
    // API layer already cleared the tokens. Do LOCAL teardown only — no server logout or
    // push-token unregister, both of which need a valid token. Idempotent: a no-op once
    // logged out, so parallel 401s that each trigger this can't double-tear-down.
    if (get().user === null) return;

    // Guaranteed teardown FIRST. Routing is reactive to `user`, so clearing it + the tokens
    // here routes to login unconditionally. If this ran last, a throwing best-effort step
    // below (e.g. a voice/WebRTC teardown) would abandon it and revive the F5 zombie
    // (logged-in UI, every request 401) — failure-path audit: never leave the critical
    // state unwritten behind a fallible step.
    clearTokens(); // idempotent — the refresh flow already cleared them
    set({ user: null });
    resetMarkReadTracking(); // cannot throw; belongs with the guaranteed teardown

    // Best-effort local cleanup, each isolated so one failure can't skip the rest.
    try {
      endP2PCallForLogout();
    } catch (err) {
      console.error("[authStore] forceLogout: call teardown failed", err);
    }
    try {
      const voiceState = useVoiceStore.getState();
      if (voiceState.currentVoiceChannelId) {
        if (voiceState._onLeaveCallback) {
          voiceState._onLeaveCallback();
        } else {
          voiceState.leaveVoiceChannel();
        }
      }
    } catch (err) {
      console.error("[authStore] forceLogout: voice teardown failed", err);
    }
    try {
      await useE2EEStore.getState().reset();
    } catch (err) {
      console.error("[authStore] forceLogout: e2ee reset failed", err);
    }
    try {
      usePreferencesStore.getState().reset();
      useGuideStore.getState().reset();
      closeGuideSurfaces();
      clearCachedPushToken();
      useSettingsStore.getState().closeSettings();
    } catch (err) {
      console.error("[authStore] forceLogout: cleanup failed", err);
    }
  },

  /**
   * Restore session from stored token on app start. Three outcomes: signed in; rejected (tokens
   * cleared by the API layer → login); unreachable (network/5xx — tokens kept, `isServerUnreachable`
   * set, and the caller retries). Safe to call repeatedly; concurrent calls share one attempt.
   */
  initialize: async () => {
    if (initializeInFlight) return initializeInFlight;
    initializeInFlight = (async () => {
      // Wire the API layer's auth-rejection signal (refresh 401/403) → forced logout, so a
      // mid-session token revocation routes to login instead of a zombie logged-in UI whose
      // every request 401s (F5). Registered here (app boot, before any authenticated request,
      // even a no-token → login flow) rather than at module scope — a module-load side-effect
      // would run during the authStore↔voiceStore circular import and break partial mocks.
      setAuthRejectedHandler(() => {
        useAuthStore.getState().forceLogout().catch((err) => {
          console.error("[authStore] forceLogout failed", err);
        });
      });

      void flushPendingLogout();

      const token = localStorage.getItem("access_token");
      if (!token) {
        set({ isInitialized: true, isServerUnreachable: false });
        return;
      }
      const fileToken = localStorage.getItem("file_token");
      if (fileToken) {
        void window.electronAPI?.setFileAuthToken(fileToken, API_BASE_URL);
      }

      const res = await authApi.getMe();
      if (res.success && res.data) {
        rememberSignIn(); // an existing session from before this flag existed
        syncLanguageFromUser(res.data);
        set({ user: res.data, isInitialized: true, isServerUnreachable: false });
        usePreferencesStore.getState().fetchAndApply();
        return;
      }

      // The API layer clears tokens ONLY on a genuine 401/403 refresh rejection, so tokens still
      // present plus a transient status means the server, not the session, is the problem (F4):
      // keep everything and let the connecting screen retry.
      if (getAccessToken() && getRefreshToken() && isTransientStatus(res.httpStatus)) {
        set({ isInitialized: true, isServerUnreachable: true });
        return;
      }

      // Not resumable now. Only run the logged-out push-cache cleanup when the tokens are actually
      // gone (a real rejection); a non-auth failure keeps them for the next launch, as before.
      if (!getAccessToken()) {
        clearCachedPushToken();
      }
      set({ isInitialized: true, isServerUnreachable: false });
    })();
    try {
      await initializeInFlight;
    } finally {
      initializeInFlight = null;
    }
  },

  abandonSession: () => {
    const refreshToken = getRefreshToken();
    if (refreshToken) localStorage.setItem(PENDING_LOGOUT_KEY, refreshToken);
    clearTokens();
    clearCachedPushToken();
    set({ user: null, isServerUnreachable: false });
  },

  clearError: () => set({ error: null }),

  updateUser: (partial) =>
    set((state) => ({
      user: state.user ? { ...state.user, ...partial } : null,
    })),

  replaceTokens: (access, refresh, file) => {
    setTokens(access, refresh, file);
  },

  setManualStatus: (status) => {
    localStorage.setItem(MANUAL_STATUS_KEY, status);
    set((state) => ({
      manualStatus: status,
      user: state.user ? { ...state.user, status } : null,
    }));
  },
}));
