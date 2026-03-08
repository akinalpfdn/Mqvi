/**
 * voiceStore — Voice channel state management.
 *
 * Handles voice states, LiveKit connection info, local controls (mute/deafen/stream),
 * and persisted voice settings (input mode, PTT key, mic sensitivity, volumes, devices).
 *
 * Discord-like behaviors:
 * - Mute toggle: if deafened, deafen is disabled first
 * - Deafen toggle: enabling deafen also mutes; disabling deafen also unmutes
 * - A user can only be in one voice channel at a time
 */

import { create } from "zustand";
import type { VoiceState, VoiceStateUpdateData, VoiceTokenResponse } from "../types";
import * as voiceApi from "../api/voice";
import { useServerStore } from "./serverStore";
import { playJoinSound, playLeaveSound, closeAudioContext } from "../utils/sounds";

// ─── localStorage Persistence ───

const STORAGE_KEY = "mqvi_voice_settings";

type VoiceSettings = {
  inputMode: InputMode;
  pttKey: string;
  micSensitivity: number;
  userVolumes: Record<string, number>;
  inputDevice: string;
  outputDevice: string;
  masterVolume: number;
  soundsEnabled: boolean;
  /** Per-user local mute — only affects this client */
  localMutedUsers: Record<string, boolean>;
  /** RNNoise ML-based noise suppression */
  noiseReduction: boolean;
  /** Per-user screen share audio volume (0-200, default 100) */
  screenShareVolumes: Record<string, number>;
  /** Share system audio when screen sharing (default: false to avoid echo) */
  screenShareAudio: boolean;
};

type InputMode = "voice_activity" | "push_to_talk";

const DEFAULT_SETTINGS: VoiceSettings = {
  inputMode: "voice_activity",
  pttKey: "Space",
  micSensitivity: 50,
  userVolumes: {},
  inputDevice: "",
  outputDevice: "",
  masterVolume: 100,
  soundsEnabled: true,
  localMutedUsers: {},
  noiseReduction: false,
  screenShareVolumes: {},
  screenShareAudio: false,
};

/** Loads voice settings from localStorage with partial merge (new keys get defaults). */
function loadSettings(): VoiceSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };

    const parsed = JSON.parse(raw) as Partial<VoiceSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
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
}

const initialSettings = loadSettings();

export type { InputMode };

type VoiceStore = {
  /** channelId -> VoiceState[] mapping */
  voiceStates: Record<string, VoiceState[]>;
  currentVoiceChannelId: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  isStreaming: boolean;
  livekitUrl: string | null;
  livekitToken: string | null;
  /** Room-level E2EE passphrase (SFrame) */
  e2eePassphrase: string | null;
  /** Monotonically increasing — discards stale API responses */
  _joinGeneration: number;

  // ─── Voice Settings (persisted) ───

  inputMode: InputMode;
  /** PTT key — uses KeyboardEvent.code (layout-independent) */
  pttKey: string;
  /** Mic sensitivity (0-100) */
  micSensitivity: number;
  /** Per-user volume: userId -> volume (0-200, default 100) */
  userVolumes: Record<string, number>;
  inputDevice: string;
  outputDevice: string;
  /** Master volume (0-100) */
  masterVolume: number;
  soundsEnabled: boolean;
  screenShareAudio: boolean;
  localMutedUsers: Record<string, boolean>;
  noiseReduction: boolean;
  screenShareVolumes: Record<string, number>;

  /** Currently speaking users — transient, not persisted */
  activeSpeakers: Record<string, boolean>;

  /**
   * Users whose screen shares we're watching.
   * Default is none — subscribe on sidebar click for bandwidth savings.
   */
  watchingScreenShares: Record<string, boolean>;

  /** Screen share viewer counts: streamerUserID -> viewer count */
  screenShareViewers: Record<string, number>;

  /** Pre-mute volume values for local mute restore */
  preMuteVolumes: Record<string, number>;

  /** LiveKit signal server round-trip time (ms) */
  rtt: number;

  // ─── Actions ───

  joinVoiceChannel: (channelId: string) => Promise<VoiceTokenResponse | null>;
  leaveVoiceChannel: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  setStreaming: (isStreaming: boolean) => void;

  // ─── Voice Settings Actions ───

  setInputMode: (mode: InputMode) => void;
  setPTTKey: (key: string) => void;
  setMicSensitivity: (value: number) => void;
  setUserVolume: (userId: string, volume: number) => void;
  setScreenShareVolume: (userId: string, volume: number) => void;
  setInputDevice: (deviceId: string) => void;
  setOutputDevice: (deviceId: string) => void;
  setMasterVolume: (value: number) => void;
  setSoundsEnabled: (enabled: boolean) => void;
  setScreenShareAudio: (enabled: boolean) => void;
  setNoiseReduction: (enabled: boolean) => void;
  setRtt: (rtt: number) => void;
  setActiveSpeakers: (speakerIds: string[]) => void;
  toggleWatchScreenShare: (userId: string) => void;
  /** Double-click focus — keep only this user's stream, close all others */
  focusScreenShare: (userId: string) => void;
  toggleLocalMute: (userId: string) => void;

  // ─── Cross-store Callback ───

  /** Tab close voice leave callback — registered by useVoice hook */
  _onLeaveCallback: (() => void) | null;
  registerOnLeave: (fn: (() => void) | null) => void;

  /** Generic WS send callback — avoids prop drilling for deep components */
  _wsSend: ((op: string, data?: unknown) => void) | null;
  registerWsSend: (fn: ((op: string, data?: unknown) => void) | null) => void;

  // ─── WS Event Handlers ───

  handleVoiceStateUpdate: (data: VoiceStateUpdateData) => void;
  handleVoiceStatesSync: (states: VoiceState[]) => void;
  updateUserInfo: (userId: string, displayName: string, avatarUrl: string) => void;
  handleForceDisconnect: () => void;
  handleScreenShareViewerUpdate: (data: { streamer_user_id: string; channel_id: string; viewer_count: number; viewer_user_id: string; action: string }) => void;
};

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  voiceStates: {},
  currentVoiceChannelId: null,
  isMuted: false,
  isDeafened: false,
  isStreaming: false,
  livekitUrl: null,
  livekitToken: null,
  e2eePassphrase: null,
  _joinGeneration: 0,

  // ─── Voice Settings (loaded from localStorage) ───
  inputMode: initialSettings.inputMode,
  pttKey: initialSettings.pttKey,
  micSensitivity: initialSettings.micSensitivity,
  userVolumes: initialSettings.userVolumes,
  inputDevice: initialSettings.inputDevice,
  outputDevice: initialSettings.outputDevice,
  masterVolume: initialSettings.masterVolume,
  soundsEnabled: initialSettings.soundsEnabled,
  screenShareAudio: initialSettings.screenShareAudio,
  localMutedUsers: initialSettings.localMutedUsers,
  noiseReduction: initialSettings.noiseReduction,
  screenShareVolumes: initialSettings.screenShareVolumes,
  activeSpeakers: {},
  watchingScreenShares: {},
  screenShareViewers: {},
  preMuteVolumes: {},
  rtt: 0,

  // ─── Cross-store Callback ───
  _onLeaveCallback: null,
  registerOnLeave: (fn) => set({ _onLeaveCallback: fn }),
  _wsSend: null,
  registerWsSend: (fn) => set({ _wsSend: fn }),

  // ─── Actions ───

  joinVoiceChannel: async (channelId: string) => {
    try {
      const serverId = useServerStore.getState().activeServerId;
      if (!serverId) return null;

      const gen = get()._joinGeneration + 1;
      set({ _joinGeneration: gen });

      const response = await voiceApi.getVoiceToken(serverId, channelId);

      // Discard stale response if generation changed (leave/join interleaved)
      if (get()._joinGeneration !== gen) {
        console.log("[voiceStore] Stale join response discarded (gen mismatch)");
        return null;
      }

      if (!response.success || !response.data) {
        console.error("[voiceStore] Failed to get voice token:", response.error);
        return null;
      }

      console.log("[voiceStore] Voice token obtained, connecting to:", response.data.url);

      // PTT mode starts muted (unmuted on key press)
      const startMuted = get().inputMode === "push_to_talk";

      set({
        currentVoiceChannelId: channelId,
        livekitUrl: response.data.url,
        livekitToken: response.data.token,
        e2eePassphrase: response.data.e2ee_passphrase ?? null,
        isMuted: startMuted,
        isDeafened: false,
        isStreaming: false,
      });

      return response.data;
    } catch (err) {
      console.error("[voiceStore] Voice join error:", err);
      return null;
    }
  },

  leaveVoiceChannel: () => {
    // Send unwatch WS events for all active screen share watches before clearing
    const { watchingScreenShares, _wsSend } = get();
    if (_wsSend) {
      for (const streamerId of Object.keys(watchingScreenShares)) {
        _wsSend("screen_share_watch", { streamer_user_id: streamerId, watching: false });
      }
    }

    set({
      currentVoiceChannelId: null,
      livekitUrl: null,
      livekitToken: null,
      e2eePassphrase: null,
      isMuted: false,
      isDeafened: false,
      isStreaming: false,
      activeSpeakers: {},
      watchingScreenShares: {},
      screenShareViewers: {},
      rtt: 0,
      _joinGeneration: get()._joinGeneration + 1,
    });

    // Release AudioContext memory (2-5MB + accumulated node refs)
    closeAudioContext();
  },

  toggleMute: () => {
    const { isMuted, isDeafened } = get();

    if (isDeafened) {
      set({ isDeafened: false, isMuted: !isMuted });
    } else {
      set({ isMuted: !isMuted });
    }
  },

  toggleDeafen: () => {
    const { isDeafened } = get();

    if (!isDeafened) {
      // Deafen on -> mute also on (Discord behavior)
      set({ isDeafened: true, isMuted: true });
    } else {
      // Deafen off -> unmute too (Discord behavior)
      set({ isDeafened: false, isMuted: false });
    }
  },

  setStreaming: (isStreaming: boolean) => {
    set({ isStreaming });
  },

  // ─── Voice Settings Actions ───
  // Each setter reads current settings and persists atomically.

  setInputMode: (mode) => {
    set({ inputMode: mode });
    const s = get();
    saveSettings({
      inputMode: mode,
      pttKey: s.pttKey,
      micSensitivity: s.micSensitivity,
      userVolumes: s.userVolumes,
      inputDevice: s.inputDevice,
      outputDevice: s.outputDevice,
      masterVolume: s.masterVolume,
      soundsEnabled: s.soundsEnabled,
      localMutedUsers: s.localMutedUsers,
      noiseReduction: s.noiseReduction,
      screenShareVolumes: s.screenShareVolumes,
      screenShareAudio: s.screenShareAudio,
    });
  },

  setPTTKey: (key) => {
    set({ pttKey: key });
    const s = get();
    saveSettings({
      inputMode: s.inputMode,
      pttKey: key,
      micSensitivity: s.micSensitivity,
      userVolumes: s.userVolumes,
      inputDevice: s.inputDevice,
      outputDevice: s.outputDevice,
      masterVolume: s.masterVolume,
      soundsEnabled: s.soundsEnabled,
      localMutedUsers: s.localMutedUsers,
      noiseReduction: s.noiseReduction,
      screenShareVolumes: s.screenShareVolumes,
      screenShareAudio: s.screenShareAudio,
    });
  },

  setMicSensitivity: (value) => {
    set({ micSensitivity: value });
    const s = get();
    saveSettings({
      inputMode: s.inputMode,
      pttKey: s.pttKey,
      micSensitivity: value,
      userVolumes: s.userVolumes,
      inputDevice: s.inputDevice,
      outputDevice: s.outputDevice,
      masterVolume: s.masterVolume,
      soundsEnabled: s.soundsEnabled,
      localMutedUsers: s.localMutedUsers,
      noiseReduction: s.noiseReduction,
      screenShareVolumes: s.screenShareVolumes,
      screenShareAudio: s.screenShareAudio,
    });
  },

  setUserVolume: (userId, volume) => {
    const newVolumes = { ...get().userVolumes, [userId]: volume };
    set({ userVolumes: newVolumes });
    const s = get();
    saveSettings({
      inputMode: s.inputMode,
      pttKey: s.pttKey,
      micSensitivity: s.micSensitivity,
      userVolumes: newVolumes,
      inputDevice: s.inputDevice,
      outputDevice: s.outputDevice,
      masterVolume: s.masterVolume,
      soundsEnabled: s.soundsEnabled,
      localMutedUsers: s.localMutedUsers,
      noiseReduction: s.noiseReduction,
      screenShareVolumes: s.screenShareVolumes,
      screenShareAudio: s.screenShareAudio,
    });
  },

  setScreenShareVolume: (userId, volume) => {
    const newVolumes = { ...get().screenShareVolumes, [userId]: volume };
    set({ screenShareVolumes: newVolumes });
    const s = get();
    saveSettings({
      inputMode: s.inputMode,
      pttKey: s.pttKey,
      micSensitivity: s.micSensitivity,
      userVolumes: s.userVolumes,
      inputDevice: s.inputDevice,
      outputDevice: s.outputDevice,
      masterVolume: s.masterVolume,
      soundsEnabled: s.soundsEnabled,
      localMutedUsers: s.localMutedUsers,
      noiseReduction: s.noiseReduction,
      screenShareVolumes: newVolumes,
      screenShareAudio: s.screenShareAudio,
    });
  },

  setInputDevice: (deviceId) => {
    set({ inputDevice: deviceId });
    const s = get();
    saveSettings({
      inputMode: s.inputMode,
      pttKey: s.pttKey,
      micSensitivity: s.micSensitivity,
      userVolumes: s.userVolumes,
      inputDevice: deviceId,
      outputDevice: s.outputDevice,
      masterVolume: s.masterVolume,
      soundsEnabled: s.soundsEnabled,
      localMutedUsers: s.localMutedUsers,
      noiseReduction: s.noiseReduction,
      screenShareVolumes: s.screenShareVolumes,
      screenShareAudio: s.screenShareAudio,
    });
  },

  setOutputDevice: (deviceId) => {
    set({ outputDevice: deviceId });
    const s = get();
    saveSettings({
      inputMode: s.inputMode,
      pttKey: s.pttKey,
      micSensitivity: s.micSensitivity,
      userVolumes: s.userVolumes,
      inputDevice: s.inputDevice,
      outputDevice: deviceId,
      masterVolume: s.masterVolume,
      soundsEnabled: s.soundsEnabled,
      localMutedUsers: s.localMutedUsers,
      noiseReduction: s.noiseReduction,
      screenShareVolumes: s.screenShareVolumes,
      screenShareAudio: s.screenShareAudio,
    });
  },

  setMasterVolume: (value) => {
    set({ masterVolume: value });
    const s = get();
    saveSettings({
      inputMode: s.inputMode,
      pttKey: s.pttKey,
      micSensitivity: s.micSensitivity,
      userVolumes: s.userVolumes,
      inputDevice: s.inputDevice,
      outputDevice: s.outputDevice,
      masterVolume: value,
      soundsEnabled: s.soundsEnabled,
      localMutedUsers: s.localMutedUsers,
      noiseReduction: s.noiseReduction,
      screenShareVolumes: s.screenShareVolumes,
      screenShareAudio: s.screenShareAudio,
    });
  },

  setSoundsEnabled: (enabled) => {
    set({ soundsEnabled: enabled });
    const s = get();
    saveSettings({
      inputMode: s.inputMode,
      pttKey: s.pttKey,
      micSensitivity: s.micSensitivity,
      userVolumes: s.userVolumes,
      inputDevice: s.inputDevice,
      outputDevice: s.outputDevice,
      masterVolume: s.masterVolume,
      soundsEnabled: enabled,
      localMutedUsers: s.localMutedUsers,
      noiseReduction: s.noiseReduction,
      screenShareVolumes: s.screenShareVolumes,
      screenShareAudio: s.screenShareAudio,
    });
  },

  setScreenShareAudio: (enabled) => {
    set({ screenShareAudio: enabled });
    const s = get();
    saveSettings({
      inputMode: s.inputMode,
      pttKey: s.pttKey,
      micSensitivity: s.micSensitivity,
      userVolumes: s.userVolumes,
      inputDevice: s.inputDevice,
      outputDevice: s.outputDevice,
      masterVolume: s.masterVolume,
      soundsEnabled: s.soundsEnabled,
      localMutedUsers: s.localMutedUsers,
      noiseReduction: s.noiseReduction,
      screenShareVolumes: s.screenShareVolumes,
      screenShareAudio: enabled,
    });
  },

  setNoiseReduction: (enabled) => {
    set({ noiseReduction: enabled });
    const s = get();
    saveSettings({
      inputMode: s.inputMode,
      pttKey: s.pttKey,
      micSensitivity: s.micSensitivity,
      userVolumes: s.userVolumes,
      inputDevice: s.inputDevice,
      outputDevice: s.outputDevice,
      masterVolume: s.masterVolume,
      soundsEnabled: s.soundsEnabled,
      localMutedUsers: s.localMutedUsers,
      noiseReduction: enabled,
      screenShareVolumes: s.screenShareVolumes,
      screenShareAudio: s.screenShareAudio,
    });
  },

  setRtt: (rtt) => set({ rtt }),

  setActiveSpeakers: (speakerIds) => {
    const map: Record<string, boolean> = {};
    for (const id of speakerIds) {
      map[id] = true;
    }
    set({ activeSpeakers: map });
  },

  toggleWatchScreenShare: (userId: string) => {
    const { watchingScreenShares, _wsSend } = get();
    const isWatching = watchingScreenShares[userId] ?? false;

    if (isWatching) {
      const next = { ...watchingScreenShares };
      delete next[userId];
      set({ watchingScreenShares: next });
      playLeaveSound();
    } else {
      set({ watchingScreenShares: { ...watchingScreenShares, [userId]: true } });
      playJoinSound();
    }

    // Notify server about watch state change
    if (_wsSend) {
      _wsSend("screen_share_watch", {
        streamer_user_id: userId,
        watching: !isWatching,
      });
    }
  },

  focusScreenShare: (userId: string) => {
    const { watchingScreenShares, _wsSend } = get();
    const watchingIds = Object.keys(watchingScreenShares);

    if (watchingIds.length === 1 && watchingScreenShares[userId]) return;

    // Notify server: unwatch all others, watch this one
    if (_wsSend) {
      for (const id of watchingIds) {
        if (id !== userId) {
          _wsSend("screen_share_watch", { streamer_user_id: id, watching: false });
        }
      }
      if (!watchingScreenShares[userId]) {
        _wsSend("screen_share_watch", { streamer_user_id: userId, watching: true });
      }
    }

    set({ watchingScreenShares: { [userId]: true } });
    playLeaveSound();
  },

  toggleLocalMute: (userId: string) => {
    const { localMutedUsers, preMuteVolumes, userVolumes } = get();
    const isCurrentlyMuted = localMutedUsers[userId] ?? false;

    if (isCurrentlyMuted) {
      // Unmute: restore previous volume
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

      const s = get();
      saveSettings({
        inputMode: s.inputMode,
        pttKey: s.pttKey,
        micSensitivity: s.micSensitivity,
        userVolumes: newVolumes,
        inputDevice: s.inputDevice,
        outputDevice: s.outputDevice,
        masterVolume: s.masterVolume,
        soundsEnabled: s.soundsEnabled,
        localMutedUsers: newLocalMuted,
        noiseReduction: s.noiseReduction,
        screenShareVolumes: s.screenShareVolumes,
        screenShareAudio: s.screenShareAudio,
      });
    } else {
      // Mute: save current volume, set to 0
      const currentVolume = userVolumes[userId] ?? 100;
      const newLocalMuted = { ...localMutedUsers, [userId]: true };
      const newPreMute = { ...preMuteVolumes, [userId]: currentVolume };
      const newVolumes = { ...userVolumes, [userId]: 0 };

      set({
        localMutedUsers: newLocalMuted,
        preMuteVolumes: newPreMute,
        userVolumes: newVolumes,
      });

      const s = get();
      saveSettings({
        inputMode: s.inputMode,
        pttKey: s.pttKey,
        micSensitivity: s.micSensitivity,
        userVolumes: newVolumes,
        inputDevice: s.inputDevice,
        outputDevice: s.outputDevice,
        masterVolume: s.masterVolume,
        soundsEnabled: s.soundsEnabled,
        localMutedUsers: newLocalMuted,
        noiseReduction: s.noiseReduction,
        screenShareVolumes: s.screenShareVolumes,
        screenShareAudio: s.screenShareAudio,
      });
    }
  },

  // ─── WS Event Handlers ───

  handleVoiceStateUpdate: (data: VoiceStateUpdateData) => {
    set((state) => {
      const newStates = { ...state.voiceStates };

      switch (data.action) {
        case "join": {
          // Remove user from all channels (can only be in one)
          for (const channelId of Object.keys(newStates)) {
            newStates[channelId] = newStates[channelId].filter(
              (s) => s.user_id !== data.user_id
            );
            if (newStates[channelId].length === 0) {
              delete newStates[channelId];
            }
          }

          const channelStates = newStates[data.channel_id] ?? [];
          newStates[data.channel_id] = [
            ...channelStates,
            {
              user_id: data.user_id,
              channel_id: data.channel_id,
              username: data.username,
              display_name: data.display_name,
              avatar_url: data.avatar_url,
              is_muted: data.is_muted,
              is_deafened: data.is_deafened,
              is_streaming: data.is_streaming,
              is_server_muted: data.is_server_muted,
              is_server_deafened: data.is_server_deafened,
            },
          ];
          break;
        }

        case "leave": {
          if (newStates[data.channel_id]) {
            newStates[data.channel_id] = newStates[data.channel_id].filter(
              (s) => s.user_id !== data.user_id
            );
            if (newStates[data.channel_id].length === 0) {
              delete newStates[data.channel_id];
            }
          }
          break;
        }

        case "update": {
          if (newStates[data.channel_id]) {
            newStates[data.channel_id] = newStates[data.channel_id].map((s) =>
              s.user_id === data.user_id
                ? {
                    ...s,
                    is_muted: data.is_muted,
                    is_deafened: data.is_deafened,
                    is_streaming: data.is_streaming,
                    is_server_muted: data.is_server_muted,
                    is_server_deafened: data.is_server_deafened,
                  }
                : s
            );
          }
          break;
        }
      }

      return { voiceStates: newStates };
    });
  },

  handleVoiceStatesSync: (states: VoiceState[]) => {
    const grouped: Record<string, VoiceState[]> = {};

    for (const state of states) {
      if (!grouped[state.channel_id]) {
        grouped[state.channel_id] = [];
      }
      grouped[state.channel_id].push(state);
    }

    set({ voiceStates: grouped });
  },

  updateUserInfo: (userId, displayName, avatarUrl) => {
    set((state) => {
      let changed = false;
      const newStates = { ...state.voiceStates };

      for (const channelId of Object.keys(newStates)) {
        const idx = newStates[channelId].findIndex((s) => s.user_id === userId);
        if (idx !== -1) {
          const entry = newStates[channelId][idx];
          if (entry.display_name !== displayName || entry.avatar_url !== avatarUrl) {
            const newArr = [...newStates[channelId]];
            newArr[idx] = { ...entry, display_name: displayName, avatar_url: avatarUrl };
            newStates[channelId] = newArr;
            changed = true;
          }
        }
      }

      return changed ? { voiceStates: newStates } : {};
    });
  },

  handleForceDisconnect: () => {
    // Admin force-disconnected us — same cleanup as leave but no WS event sent
    // (server already cleared state).
    set({
      currentVoiceChannelId: null,
      livekitUrl: null,
      livekitToken: null,
      e2eePassphrase: null,
      isMuted: false,
      isDeafened: false,
      isStreaming: false,
      activeSpeakers: {},
      watchingScreenShares: {},
      screenShareViewers: {},
      rtt: 0,
    });
  },

  handleScreenShareViewerUpdate: (data) => {
    set((state) => {
      const next = { ...state.screenShareViewers };
      if (data.viewer_count > 0) {
        next[data.streamer_user_id] = data.viewer_count;
      } else {
        delete next[data.streamer_user_id];
      }
      return { screenShareViewers: next };
    });
  },
}));
