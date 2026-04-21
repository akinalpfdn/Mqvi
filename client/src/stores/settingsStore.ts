/**
 * Settings Store — settings modal + theme state management.
 *
 * Theme is synced to server via preferencesStore. On app load,
 * localStorage is used as immediate fallback; server preferences
 * override once fetched.
 */

import { create } from "zustand";
import { type ThemeId, DEFAULT_THEME, THEMES, applyTheme } from "../styles/themes";
import { usePreferencesStore } from "./preferencesStore";

const THEME_STORAGE_KEY = "mqvi_theme";
const BLUR_STORAGE_KEY = "mqvi_blur_enabled";
const WALLPAPER_ENABLED_KEY = "mqvi_wallpaper_enabled";
const TRANSPARENT_KEY = "mqvi_transparent_bg";

function loadPersistedTheme(): ThemeId {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored && stored in THEMES) {
      return stored as ThemeId;
    }
  } catch {
    /* localStorage access error */
  }
  return DEFAULT_THEME;
}

function loadPersistedBlur(): boolean {
  try {
    const stored = localStorage.getItem(BLUR_STORAGE_KEY);
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    /* localStorage access error */
  }
  // Heuristic default: disable blur on low-end hardware or when user requests reduced transparency
  if (typeof navigator !== "undefined" && typeof navigator.hardwareConcurrency === "number" && navigator.hardwareConcurrency < 4) {
    return false;
  }
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches) {
    return false;
  }
  return true;
}

function loadPersistedWallpaperEnabled(): boolean {
  try {
    const stored = localStorage.getItem(WALLPAPER_ENABLED_KEY);
    if (stored === "0") return false;
  } catch {
    /* localStorage access error */
  }
  return true;
}

function loadPersistedTransparent(): boolean {
  try {
    const stored = localStorage.getItem(TRANSPARENT_KEY);
    if (stored === "1") return true;
  } catch {
    /* localStorage access error */
  }
  return false;
}

type SettingsTab =
  | "profile"
  | "appearance"
  | "general"
  | "voice"
  | "security"
  | "encryption"
  | "server-general"
  | "channels"
  | "roles"
  | "members"
  | "invites"
  | "platform"
  | "platform-servers"
  | "platform-users"
  | "platform-reports"
  | "platform-logs"
  | "platform-connections"
  | "platform-feedback"
  | "feedback"
  | "blocked-users";

type SettingsState = {
  isOpen: boolean;
  activeTab: SettingsTab;
  themeId: ThemeId;
  blurEnabled: boolean;
  wallpaperEnabled: boolean;
  /** Transparent window background — desktop shows through */
  transparentBackground: boolean;
  /** Live preview blob URL — applied to the app background without persisting. */
  pendingWallpaperPreviewUrl: string | null;

  openSettings: (tab?: SettingsTab) => void;
  closeSettings: () => void;
  setActiveTab: (tab: SettingsTab) => void;
  setTheme: (id: ThemeId) => void;
  setBlurEnabled: (enabled: boolean) => void;
  setWallpaperEnabled: (enabled: boolean) => void;
  setTransparentBackground: (enabled: boolean) => void;
  setPendingWallpaperPreviewUrl: (url: string | null) => void;
  /** Apply theme from server preferences (no re-sync to server) */
  applyFromServer: (themeId: string) => void;
};

export type { SettingsTab };

const initialTheme = loadPersistedTheme();
const initialBlur = loadPersistedBlur();
const initialWallpaperEnabled = loadPersistedWallpaperEnabled();
const initialTransparent = loadPersistedTransparent();

export const useSettingsStore = create<SettingsState>((set) => ({
  isOpen: false,
  activeTab: "profile",
  themeId: initialTheme,
  blurEnabled: initialBlur,
  wallpaperEnabled: initialWallpaperEnabled,
  transparentBackground: initialTransparent,
  pendingWallpaperPreviewUrl: null,

  openSettings: (tab = "profile") => set({ isOpen: true, activeTab: tab }),
  closeSettings: () => set({ isOpen: false }),
  setActiveTab: (tab) => set({ activeTab: tab }),

  setTheme: (id) => {
    applyTheme(id);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id);
    } catch {
      /* localStorage full or inaccessible */
    }
    set({ themeId: id });
    // Sync to server
    usePreferencesStore.getState().set({ theme: id });
  },

  setBlurEnabled: (enabled) => {
    try {
      localStorage.setItem(BLUR_STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      /* localStorage full or inaccessible */
    }
    set({ blurEnabled: enabled });
  },

  setWallpaperEnabled: (enabled) => {
    try {
      localStorage.setItem(WALLPAPER_ENABLED_KEY, enabled ? "1" : "0");
    } catch {
      /* localStorage full or inaccessible */
    }
    set({ wallpaperEnabled: enabled });
  },

  setTransparentBackground: (enabled) => {
    try {
      localStorage.setItem(TRANSPARENT_KEY, enabled ? "1" : "0");
    } catch {
      /* localStorage full or inaccessible */
    }
    // Sync to Electron app settings (requires restart to take effect)
    if (window.electronAPI?.setAppSetting) {
      window.electronAPI.setAppSetting("transparentBackground", enabled);
    }
    // When enabling transparent, disable wallpaper
    if (enabled) {
      try { localStorage.setItem(WALLPAPER_ENABLED_KEY, "0"); } catch { /* */ }
      set({ transparentBackground: true, wallpaperEnabled: false });
    } else {
      set({ transparentBackground: enabled });
    }
  },

  setPendingWallpaperPreviewUrl: (url) => set({ pendingWallpaperPreviewUrl: url }),

  applyFromServer: (themeId: string) => {
    if (themeId in THEMES) {
      const id = themeId as ThemeId;
      applyTheme(id);
      try {
        localStorage.setItem(THEME_STORAGE_KEY, id);
      } catch { /* ignore */ }
      set({ themeId: id });
    }
  },
}));

// Apply persisted theme on module load
applyTheme(initialTheme);
