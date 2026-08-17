/**
 * voiceSettingsSlice — persisted voice settings (input mode, PTT, volumes, devices, etc.)
 *
 * All setters follow the same pattern: update Zustand state, then persist the full
 * current settings snapshot via saveSettings(). The `currentSettings(state)` helper
 * eliminates the repeated 15-field object boilerplate.
 */

import type { StateCreator } from "zustand";
import { usePreferencesStore } from "../preferencesStore";
import type { VoiceStore } from "../voiceStore";

export type InputMode = "voice_activity" | "push_to_talk";
export type ScreenShareQuality = "720p" | "1080p";
/**
 * Which engine renders a screen share:
 * - "smooth" (Akıcı Görüntü) — native WGC + hardware encode helper; for games, films, video.
 * - "sharp"  (Net Görüntü)  — getDisplayMedia; for text, code, presentations.
 * One share flow, two engines — chosen in the screen-share modal.
 */
export type ScreenShareMode = "smooth" | "sharp";

/**
 * Which denoiser runs on the mic:
 * - "off"      — no denoising; the sensitivity gate still applies.
 * - "standard" — RNNoise, full-band. Steady noise (fan, hum) goes; the voice keeps its top end.
 * - "strong"   — GTCRN. Removes what RNNoise structurally cannot (keyboard, background speech),
 *                but its model runs at 16 kHz, so everything above 8 kHz is lost and the voice
 *                comes out duller. A trade the user makes, not an upgrade we apply for them.
 */
export type NoiseReductionMode = "off" | "standard" | "strong";

/** What the overlay on a screen share shows. "stats" is a superset of "fps", which is why this is
 *  one setting and not two toggles that could disagree. */
export type StreamStatsMode = "none" | "fps" | "stats";

/** Which corner it sits in. Global, so a split view puts both panels' overlays in the same place. */
export type StreamStatsCorner = "tl" | "tr" | "bl" | "br";

/**
 * Configurable shortcut. `code` is a KeyboardEvent.code (e.g. "KeyV") OR a
 * mouse token ("Mouse3" middle, "Mouse4" back, "Mouse5" forward).
 */
export type ShortcutBinding = {
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
};

/** True when a binding code is a mouse button rather than a keyboard key. */
export function isMouseBinding(code: string): boolean {
  return code === "Mouse3" || code === "Mouse4" || code === "Mouse5";
}

/**
 * DOM MouseEvent.button → mouse token, for the rebind capture UI.
 * Left (0) and right (2) are intentionally excluded — they're needed for normal
 * interaction. 1=middle, 3=back, 4=forward.
 */
export const DOM_BUTTON_TO_MOUSE_TOKEN: Record<number, string> = {
  1: "Mouse3",
  3: "Mouse4",
  4: "Mouse5",
};

export const DEFAULT_MUTE_SHORTCUT: ShortcutBinding = {
  code: "KeyM",
  ctrl: true,
  shift: true,
  alt: false,
};

export const DEFAULT_DEAFEN_SHORTCUT: ShortcutBinding = {
  code: "KeyD",
  ctrl: true,
  shift: true,
  alt: false,
};

export type VoiceSettings = {
  inputMode: InputMode;
  pttKey: string;
  micSensitivity: number;
  userVolumes: Record<string, number>;
  inputDevice: string;
  outputDevice: string;
  masterVolume: number;
  inputVolume: number;
  soundsEnabled: boolean;
  /** Multiplier applied on top of masterVolume for notification sounds (messages, DMs, calls, mentions). */
  notificationVolume: number;
  /** Multiplier applied on top of masterVolume for in-app SFX (mute/deafen, join/leave, watch start/stop). */
  appSoundVolume: number;
  localMutedUsers: Record<string, boolean>;
  noiseReductionMode: NoiseReductionMode;
  screenShareVolumes: Record<string, number>;
  screenShareAudio: boolean;
  screenShareQuality: ScreenShareQuality;
  screenShareMode: ScreenShareMode;
  streamStatsMode: StreamStatsMode;
  streamStatsCorner: StreamStatsCorner;
  muteShortcut: ShortcutBinding;
  deafenShortcut: ShortcutBinding;
};

const STORAGE_KEY = "mqvi_voice_settings";

export const DEFAULT_SETTINGS: VoiceSettings = {
  inputMode: "voice_activity",
  pttKey: "Space",
  micSensitivity: 50,
  userVolumes: {},
  inputDevice: "",
  outputDevice: "",
  masterVolume: 100,
  inputVolume: 100,
  soundsEnabled: true,
  notificationVolume: 100,
  appSoundVolume: 100,
  localMutedUsers: {},
  noiseReductionMode: "standard",
  screenShareVolumes: {},
  screenShareAudio: false,
  screenShareQuality: "720p",
  // Default to the native engine: the common share here is a game/video, and it falls back to
  // "sharp" on its own wherever the helper can't run (non-Electron, non-Windows, spawn failure).
  screenShareMode: "smooth",
  // Off by default: it is a diagnostic, and the picture is what people came for.
  streamStatsMode: "none",
  streamStatsCorner: "tl",
  muteShortcut: DEFAULT_MUTE_SHORTCUT,
  deafenShortcut: DEFAULT_DEAFEN_SHORTCUT,
};

/** The shape written before noise reduction became three modes. */
type LegacySettings = { noiseReduction?: boolean };

/**
 * Turns whatever is on disk into the current shape.
 *
 * `noiseReduction` used to be a boolean and is still sitting in every existing user's localStorage
 * and in `voice_settings` on the server, so it arrives on other devices too. The merge below is a
 * plain spread with no validation, so without this the old boolean would land in a field typed as a
 * string union and the mode would read as neither "off" nor "standard".
 */
export function migrateSettings(parsed: Partial<VoiceSettings> & LegacySettings): VoiceSettings {
  const { noiseReduction, ...rest } = parsed;
  const merged = { ...DEFAULT_SETTINGS, ...rest };

  // Only when the new key is absent: once someone has chosen a mode, a stale boolean left behind by
  // an older client on another device must not overwrite it.
  if (parsed.noiseReductionMode === undefined && typeof noiseReduction === "boolean") {
    merged.noiseReductionMode = noiseReduction ? "standard" : "off";
  }
  return merged;
}

/** Loads voice settings from localStorage with partial merge (new keys get defaults). */
export function loadSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return migrateSettings(JSON.parse(raw) as Partial<VoiceSettings> & LegacySettings);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: VoiceSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage full or inaccessible */
  }
  usePreferencesStore.getState().set({ voice_settings: settings });
}

/** Extract settings-shaped subset from the current store state. */
function currentSettings(s: VoiceSettings): VoiceSettings {
  return {
    inputMode: s.inputMode,
    pttKey: s.pttKey,
    micSensitivity: s.micSensitivity,
    userVolumes: s.userVolumes,
    inputDevice: s.inputDevice,
    outputDevice: s.outputDevice,
    masterVolume: s.masterVolume,
    inputVolume: s.inputVolume,
    soundsEnabled: s.soundsEnabled,
    notificationVolume: s.notificationVolume,
    appSoundVolume: s.appSoundVolume,
    localMutedUsers: s.localMutedUsers,
    noiseReductionMode: s.noiseReductionMode,
    screenShareVolumes: s.screenShareVolumes,
    screenShareAudio: s.screenShareAudio,
    screenShareQuality: s.screenShareQuality,
    screenShareMode: s.screenShareMode,
    streamStatsMode: s.streamStatsMode,
    streamStatsCorner: s.streamStatsCorner,
    muteShortcut: s.muteShortcut,
    deafenShortcut: s.deafenShortcut,
  };
}

export type VoiceSettingsSlice = VoiceSettings & {
  /** Pre-mute volume values for local mute restore */
  preMuteVolumes: Record<string, number>;

  setInputMode: (mode: InputMode) => void;
  setPTTKey: (key: string) => void;
  setMicSensitivity: (value: number) => void;
  setUserVolume: (userId: string, volume: number) => void;
  setScreenShareVolume: (userId: string, volume: number) => void;
  setInputDevice: (deviceId: string) => void;
  setOutputDevice: (deviceId: string) => void;
  setMasterVolume: (value: number) => void;
  setInputVolume: (value: number) => void;
  setSoundsEnabled: (enabled: boolean) => void;
  setNotificationVolume: (value: number) => void;
  setAppSoundVolume: (value: number) => void;
  setScreenShareAudio: (enabled: boolean) => void;
  setScreenShareQuality: (quality: ScreenShareQuality) => void;
  setScreenShareMode: (mode: ScreenShareMode) => void;
  setStreamStatsMode: (mode: StreamStatsMode) => void;
  setStreamStatsCorner: (corner: StreamStatsCorner) => void;
  setNoiseReductionMode: (mode: NoiseReductionMode) => void;
  setMuteShortcut: (binding: ShortcutBinding) => void;
  setDeafenShortcut: (binding: ShortcutBinding) => void;
  toggleLocalMute: (userId: string) => void;
  applyFromServer: (settings: Record<string, unknown>) => void;
};

export const createVoiceSettingsSlice: StateCreator<
  VoiceStore,
  [],
  [],
  VoiceSettingsSlice
> = (set, get) => {
  const initial = loadSettings();

  return {
    inputMode: initial.inputMode,
    pttKey: initial.pttKey,
    micSensitivity: initial.micSensitivity,
    userVolumes: initial.userVolumes,
    inputDevice: initial.inputDevice,
    outputDevice: initial.outputDevice,
    masterVolume: initial.masterVolume,
    inputVolume: initial.inputVolume,
    soundsEnabled: initial.soundsEnabled,
    notificationVolume: initial.notificationVolume,
    appSoundVolume: initial.appSoundVolume,
    localMutedUsers: initial.localMutedUsers,
    noiseReductionMode: initial.noiseReductionMode,
    screenShareVolumes: initial.screenShareVolumes,
    screenShareAudio: initial.screenShareAudio,
    screenShareQuality: initial.screenShareQuality,
    screenShareMode: initial.screenShareMode,
    streamStatsMode: initial.streamStatsMode,
    streamStatsCorner: initial.streamStatsCorner,
    muteShortcut: initial.muteShortcut,
    deafenShortcut: initial.deafenShortcut,
    preMuteVolumes: {},

    setInputMode: (mode) => {
      set({ inputMode: mode });
      saveSettings(currentSettings(get()));
    },

    setPTTKey: (key) => {
      set({ pttKey: key });
      saveSettings(currentSettings(get()));
    },

    setMicSensitivity: (value) => {
      set({ micSensitivity: value });
      saveSettings(currentSettings(get()));
    },

    setUserVolume: (userId, volume) => {
      set({ userVolumes: { ...get().userVolumes, [userId]: volume } });
      saveSettings(currentSettings(get()));
    },

    setScreenShareVolume: (userId, volume) => {
      set({ screenShareVolumes: { ...get().screenShareVolumes, [userId]: volume } });
      saveSettings(currentSettings(get()));
    },

    setInputDevice: (deviceId) => {
      set({ inputDevice: deviceId });
      saveSettings(currentSettings(get()));
    },

    setOutputDevice: (deviceId) => {
      set({ outputDevice: deviceId });
      saveSettings(currentSettings(get()));
    },

    setMasterVolume: (value) => {
      set({ masterVolume: value });
      saveSettings(currentSettings(get()));
    },

    setInputVolume: (value) => {
      set({ inputVolume: value });
      saveSettings(currentSettings(get()));
    },

    setSoundsEnabled: (enabled) => {
      set({ soundsEnabled: enabled });
      saveSettings(currentSettings(get()));
    },

    setNotificationVolume: (value) => {
      set({ notificationVolume: value });
      saveSettings(currentSettings(get()));
    },

    setAppSoundVolume: (value) => {
      set({ appSoundVolume: value });
      saveSettings(currentSettings(get()));
    },

    setScreenShareAudio: (enabled) => {
      set({ screenShareAudio: enabled });
      saveSettings(currentSettings(get()));
    },

    setScreenShareQuality: (quality) => {
      set({ screenShareQuality: quality });
      saveSettings(currentSettings(get()));
    },

    setScreenShareMode: (mode) => {
      set({ screenShareMode: mode });
      saveSettings(currentSettings(get()));
    },

    setStreamStatsMode: (mode) => {
      set({ streamStatsMode: mode });
      saveSettings(currentSettings(get()));
    },

    setStreamStatsCorner: (corner) => {
      set({ streamStatsCorner: corner });
      saveSettings(currentSettings(get()));
    },

    setNoiseReductionMode: (mode) => {
      set({ noiseReductionMode: mode });
      saveSettings(currentSettings(get()));
    },

    setMuteShortcut: (binding) => {
      set({ muteShortcut: binding });
      saveSettings(currentSettings(get()));
    },

    setDeafenShortcut: (binding) => {
      set({ deafenShortcut: binding });
      saveSettings(currentSettings(get()));
    },

    toggleLocalMute: (userId: string) => {
      const { localMutedUsers, preMuteVolumes, userVolumes } = get();
      const isCurrentlyMuted = localMutedUsers[userId] ?? false;

      if (isCurrentlyMuted) {
        const restoredVolume = preMuteVolumes[userId] ?? 100;
        const newLocalMuted = { ...localMutedUsers };
        delete newLocalMuted[userId];
        const newPreMute = { ...preMuteVolumes };
        delete newPreMute[userId];
        const newVolumes = { ...userVolumes, [userId]: restoredVolume };

        set({
          localMutedUsers: newLocalMuted,
          preMuteVolumes: newPreMute,
          userVolumes: newVolumes,
        });
      } else {
        const currentVolume = userVolumes[userId] ?? 100;
        const newLocalMuted = { ...localMutedUsers, [userId]: true };
        const newPreMute = { ...preMuteVolumes, [userId]: currentVolume };
        const newVolumes = { ...userVolumes, [userId]: 0 };

        set({
          localMutedUsers: newLocalMuted,
          preMuteVolumes: newPreMute,
          userVolumes: newVolumes,
        });
      }

      saveSettings(currentSettings(get()));
    },

    applyFromServer: (settings) => {
      const merged: VoiceSettings = { ...DEFAULT_SETTINGS, ...loadSettings() };
      const keys = Object.keys(settings) as (keyof VoiceSettings)[];
      for (const key of keys) {
        if (key in merged) {
          (merged as Record<string, unknown>)[key] = settings[key];
        }
      }
      // The copy above drops `noiseReduction` because it is no longer a key of VoiceSettings, and
      // the server still holds it for anyone who has not saved since the upgrade. On a device with
      // no localStorage to migrate from, that silently turns a deliberate "off" back into
      // "standard" — so the legacy boolean is read here too, and only when the server has no mode.
      const legacy = (settings as { noiseReduction?: boolean }).noiseReduction;
      if (settings.noiseReductionMode === undefined && typeof legacy === "boolean") {
        merged.noiseReductionMode = legacy ? "standard" : "off";
      }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
      } catch {
        /* ignore */
      }
      set({
        inputMode: merged.inputMode,
        pttKey: merged.pttKey,
        micSensitivity: merged.micSensitivity,
        userVolumes: merged.userVolumes,
        inputDevice: merged.inputDevice,
        outputDevice: merged.outputDevice,
        masterVolume: merged.masterVolume,
        inputVolume: merged.inputVolume,
        soundsEnabled: merged.soundsEnabled,
        notificationVolume: merged.notificationVolume,
        appSoundVolume: merged.appSoundVolume,
        screenShareAudio: merged.screenShareAudio,
        screenShareQuality: merged.screenShareQuality,
        screenShareMode: merged.screenShareMode,
        streamStatsMode: merged.streamStatsMode,
        streamStatsCorner: merged.streamStatsCorner,
        localMutedUsers: merged.localMutedUsers,
        noiseReductionMode: merged.noiseReductionMode,
        screenShareVolumes: merged.screenShareVolumes,
        muteShortcut: merged.muteShortcut,
        deafenShortcut: merged.deafenShortcut,
      });
    },
  };
};
