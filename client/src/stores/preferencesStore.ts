/**
 * Preferences Store — server-side user preferences sync.
 *
 * Central store that fetches preferences from server on login and
 * debounces PATCH calls when settings change. Other stores (settings,
 * sidebar, voice) call `set()` to persist their state server-side.
 *
 * Preferences are a flat key-value object at the top level:
 * {
 *   theme: "midnight",
 *   sidebar_sections: { friends: true, dms: false },
 *   voice_settings: { noiseReduction: true, ... },
 * }
 */

import { create } from "zustand";
import * as preferencesApi from "../api/preferences";

type PreferencesData = Record<string, unknown>;

type PreferencesState = {
  /** Server-synced preferences data */
  data: PreferencesData;
  /** Whether initial fetch has completed */
  isLoaded: boolean;

  /** Fetch preferences from server and apply to dependent stores */
  fetchAndApply: () => Promise<void>;
  /** Set one or more preference keys and sync to server (debounced) */
  set: (partial: PreferencesData) => void;
  /** Get a preference value by key */
  get: <T = unknown>(key: string) => T | undefined;
  /** Reset store on logout */
  reset: () => void;
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 1000;

/** Pending patch buffer — accumulates changes during debounce window */
let pendingPatch: PreferencesData = {};

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  data: {},
  isLoaded: false,

  fetchAndApply: async () => {
    try {
      const res = await preferencesApi.getPreferences();
      // res.data is UserPreferencesResponse { user_id, data, updated_at }
      // The actual preferences blob is nested inside .data
      const prefs = res.data?.data;
      const data = (prefs && typeof prefs === "object" ? prefs : {}) as PreferencesData;
      set({ data, isLoaded: true });

      // Apply to dependent stores (lazy imports to avoid circular deps)
      const { useSettingsStore } = await import("./settingsStore");
      const { useSidebarStore } = await import("./sidebarStore");
      const { useVoiceStore } = await import("./voiceStore");

      // Theme
      if (typeof data.theme === "string") {
        useSettingsStore.getState().applyFromServer(data.theme);
      }

      // Sidebar sections + expanded state
      if (data.sidebar_sections && typeof data.sidebar_sections === "object") {
        const expanded = typeof data.sidebar_expanded === "boolean"
          ? data.sidebar_expanded
          : undefined;
        useSidebarStore.getState().applyFromServer(
          data.sidebar_sections as Record<string, boolean>,
          expanded,
        );
      }

      // Voice settings
      if (data.voice_settings && typeof data.voice_settings === "object") {
        useVoiceStore.getState().applyFromServer(
          data.voice_settings as Record<string, unknown>,
        );
      }
    } catch {
      // First login — no preferences yet, use defaults
      set({ isLoaded: true });
    }
  },

  set: (partial) => {
    // 1. Immediately update local state
    set((state) => ({
      data: { ...state.data, ...partial },
    }));

    // 2. Accumulate into pending patch
    Object.assign(pendingPatch, partial);

    // 3. Debounce the server call
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const patch = { ...pendingPatch };
      pendingPatch = {};
      try {
        await preferencesApi.updatePreferences(patch);
      } catch {
        // Silent fail — local state is still correct.
        // Next page load will re-fetch from server.
      }
    }, DEBOUNCE_MS);
  },

  get: <T = unknown>(key: string): T | undefined => {
    return get().data[key] as T | undefined;
  },

  reset: () => {
    // Flush any pending changes to server before resetting
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (Object.keys(pendingPatch).length > 0) {
      const patch = { ...pendingPatch };
      pendingPatch = {};
      // Fire-and-forget — best effort save before logout
      preferencesApi.updatePreferences(patch).catch(() => {});
    }
    set({ data: {}, isLoaded: false });
  },
}));
