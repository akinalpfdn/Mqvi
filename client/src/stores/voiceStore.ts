/**
 * voiceStore — Voice channel state management.
 *
 * Composes three slices:
 * - voiceSettingsSlice: persisted voice settings (input mode, PTT, volumes, devices)
 * - voiceWsSlice: WebSocket event handlers (voice state sync/update, force disconnect)
 * - voiceScreenShareSlice: screen share watch/focus actions
 *
 * This file keeps the core connection + controls (join/leave/mute/deafen/stream).
 *
 * Discord-like behaviors:
 * - Mute toggle: if deafened, deafen is disabled first
 * - Deafen toggle: enabling deafen also mutes; disabling deafen also unmutes
 * - A user can only be in one voice channel at a time
 */

import { create } from "zustand";
import type { VoiceState, VoiceStateUpdateData, VoiceTokenResponse } from "../types";
import * as voiceApi from "../api/voice";
import {
  startVoiceCallService, stopVoiceCallService,
  useNativeVoice, nativeVoiceConnect, nativeVoiceDisconnect,
  nativeVoiceSetMic, nativeVoiceSetDeafened,
} from "../utils/nativePlugins";
import { ensureMicPermission } from "../utils/devicePermissions";
import { ensureFreshToken } from "../api/client";
import { useServerStore } from "./serverStore";
import { useAuthStore } from "./authStore";
import {
  closeAudioContext,
  playMuteOnSound,
  playMuteOffSound,
  playDeafenOnSound,
  playDeafenOffSound,
} from "../utils/sounds";
import { markVoiceActive, clearVoiceRecoveryMark } from "./shared/voiceRecovery";
import {
  createVoiceSettingsSlice,
  type VoiceSettingsSlice,
  type InputMode,
  type ScreenShareQuality,
} from "./slices/voiceSettingsSlice";
import {
  createVoiceWsSlice,
  type VoiceWsSlice,
} from "./slices/voiceWsSlice";
import {
  createVoiceScreenShareSlice,
  type VoiceScreenShareSlice,
} from "./slices/voiceScreenShareSlice";

export type { InputMode, ScreenShareQuality };

// Lazy getter for the current user's id. Used to scrub our own voice entry
// on leave — circular import avoided via getState().
function getOwnUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

// ─── Mute/Deafen persistence ───
// Stored separately from voice settings: per-device, never synced to server.
// Without this, reload resets to unmuted — a privacy risk for anyone who
// intentionally joined muted and briefly disconnects.
const MUTE_STATE_KEY = "mqvi_voice_mute_state";


function loadMuteState(): { isMuted: boolean; isDeafened: boolean } {
  try {
    const raw = localStorage.getItem(MUTE_STATE_KEY);
    if (!raw) return { isMuted: false, isDeafened: false };
    const parsed = JSON.parse(raw) as { isMuted?: boolean; isDeafened?: boolean };
    return {
      isMuted: !!parsed.isMuted,
      isDeafened: !!parsed.isDeafened,
    };
  } catch {
    return { isMuted: false, isDeafened: false };
  }
}

function saveMuteState(state: { isMuted: boolean; isDeafened: boolean }): void {
  try {
    localStorage.setItem(MUTE_STATE_KEY, JSON.stringify(state));
  } catch {
    /* localStorage full or inaccessible */
  }
}

const initialMuteState = loadMuteState();

type VoiceCoreState = {
  /** channelId -> VoiceState[] mapping */
  voiceStates: Record<string, VoiceState[]>;
  currentVoiceChannelId: string | null;
  /** Server owning the current voice channel — used to disconnect on server leave/delete. */
  currentVoiceServerId: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  isStreaming: boolean;
  /** "Akıcı Görüntü" engine is live: the native capture helper is publishing {userId}_ss */
  isNativeCapturing: boolean;
  /** desktopCapturer id of the source being shared ("window:<HWND>:0" / "screen:<id>:0").
   *  Set by the picker; the audio capture needs it to scope itself to the share. */
  pickedShareSourceId: string | null;
  /** Server-enforced mute — admin silenced this user's mic */
  isServerMuted: boolean;
  /** Server-enforced deafen — admin silenced all audio for this user */
  isServerDeafened: boolean;
  livekitUrl: string | null;
  livekitToken: string | null;
  /** Room-level E2EE passphrase (SFrame) */
  e2eePassphrase: string | null;
  /** Monotonically increasing — discards stale API responses */
  _joinGeneration: number;

  /** Currently speaking users — transient, not persisted */
  activeSpeakers: Record<string, boolean>;

  /** LiveKit signal server round-trip time (ms) */
  rtt: number;

  /** Set when another session takes over voice — prevents auto-rejoin loop */
  wasReplaced: boolean;

  /** channelId → call start time (Unix ms). Populated by server; empty when channel has no participants. */
  channelTimers: Record<string, number>;

  /** Tab close voice leave callback — registered by useVoice hook */
  _onLeaveCallback: (() => void) | null;
  /** Generic WS send callback — avoids prop drilling for deep components */
  _wsSend: ((op: string, data?: unknown) => void) | null;
};

type VoiceCoreActions = {
  joinVoiceChannel: (channelId: string) => Promise<VoiceTokenResponse | null>;
  /** Hot-swap LiveKit token without disconnect cycle — used for auto-rejoin. */
  refreshVoiceToken: (channelId: string) => Promise<VoiceTokenResponse | null>;
  leaveVoiceChannel: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
  setStreaming: (isStreaming: boolean) => void;
  /**
   * "Akıcı Görüntü" engine (Electron/Windows): hand the share to the native WGC + hardware-encode
   * helper instead of getDisplayMedia. Returns false if it couldn't start, so the caller can fall
   * back to "Net Görüntü".
   */
  startNativeSmoothCapture: (sourceId: string) => Promise<boolean>;
  stopNativeSmoothCapture: () => void;
  setPickedShareSourceId: (sourceId: string | null) => void;
  setRtt: (rtt: number) => void;
  setActiveSpeakers: (speakerIds: string[]) => void;
  registerOnLeave: (fn: (() => void) | null) => void;
  registerWsSend: (fn: ((op: string, data?: unknown) => void) | null) => void;
};

export type VoiceStore =
  & VoiceCoreState
  & VoiceCoreActions
  & VoiceSettingsSlice
  & VoiceWsSlice
  & VoiceScreenShareSlice;

// Re-export so legacy direct imports still resolve
export type { VoiceStateUpdateData };

export const useVoiceStore = create<VoiceStore>((set, get, store) => ({
  // ─── Slices ───
  ...createVoiceSettingsSlice(set, get, store),
  ...createVoiceWsSlice(set, get, store),
  ...createVoiceScreenShareSlice(set, get, store),

  // ─── Core State ───
  voiceStates: {},
  currentVoiceChannelId: null,
  currentVoiceServerId: null,
  isMuted: initialMuteState.isMuted,
  isDeafened: initialMuteState.isDeafened,
  isStreaming: false,
  isNativeCapturing: false,
  pickedShareSourceId: null,
  isServerMuted: false,
  isServerDeafened: false,
  livekitUrl: null,
  livekitToken: null,
  e2eePassphrase: null,
  _joinGeneration: 0,
  activeSpeakers: {},
  channelTimers: {},
  rtt: 0,
  wasReplaced: false,
  _onLeaveCallback: null,
  _wsSend: null,

  // ─── Core Actions ───

  registerOnLeave: (fn) => set({ _onLeaveCallback: fn }),
  registerWsSend: (fn) => set({ _wsSend: fn }),

  joinVoiceChannel: async (channelId: string) => {
    try {
      const serverId = useServerStore.getState().activeServerId;
      if (!serverId) return null;

      // On mobile, ensure microphone permission before proceeding
      const micGranted = await ensureMicPermission();
      if (!micGranted) {
        console.warn("[voiceStore] Microphone permission denied");
        return null;
      }

      const gen = get()._joinGeneration + 1;
      set({ _joinGeneration: gen });

      await ensureFreshToken();
      let response = await voiceApi.getVoiceToken(serverId, channelId);

      // Retry once on auth failure — token may have expired mid-request
      if (!response.success && response.error?.includes("401")) {
        const refreshed = await ensureFreshToken();
        if (refreshed) {
          response = await voiceApi.getVoiceToken(serverId, channelId);
        }
      }

      // Discard stale response if generation changed (leave/join interleaved)
      if (get()._joinGeneration !== gen) {
        return null;
      }

      if (!response.success || !response.data) {
        console.error("[voiceStore] Failed to get voice token:", response.error);
        return null;
      }

      // isMuted is left untouched — PTT idle (mic off until key press) is
      // enforced at the track level by VoiceStateManager, not via mute state.
      const initialMuted = get().isMuted;
      const initialDeafened = get().isDeafened;

      set({
        currentVoiceChannelId: channelId,
        currentVoiceServerId: serverId,
        livekitUrl: response.data.url,
        livekitToken: response.data.token,
        e2eePassphrase: response.data.e2ee_passphrase ?? null,
        isStreaming: false,
      });

      // Remember this tab owns the voice session — enables F5 recovery
      // for THIS tab only, prevents unrelated tabs/windows from auto-joining.
      markVoiceActive(channelId);

      // iOS: connect natively (audio works in background)
      // Other platforms: VoiceProvider connects via LiveKitRoom props
      if (useNativeVoice()) {
        await nativeVoiceConnect(response.data.url, response.data.token, initialMuted, initialDeafened);
      }

      // Start native foreground service for background audio (mobile only)
      startVoiceCallService();

      return response.data;
    } catch (err) {
      console.error("[voiceStore] Voice join error:", err);
      return null;
    }
  },

  refreshVoiceToken: async (channelId: string) => {
    try {
      const serverId = get().currentVoiceServerId ?? useServerStore.getState().activeServerId;
      if (!serverId) return null;

      await ensureFreshToken();
      const response = await voiceApi.getVoiceToken(serverId, channelId);

      if (!response.success || !response.data) {
        return null;
      }

      // Hot-swap only connection credentials — keep all other state intact.
      // This avoids the connect=false→true transition that causes LiveKitRoom
      // to create multiple Room instances (the DUPLICATE_IDENTITY ping-pong).
      set({
        livekitUrl: response.data.url,
        livekitToken: response.data.token,
        e2eePassphrase: response.data.e2ee_passphrase ?? null,
      });

      return response.data;
    } catch (err) {
      console.error("[voiceStore] refreshVoiceToken error:", err);
      return null;
    }
  },

  leaveVoiceChannel: () => {
    clearVoiceRecoveryMark();

    // iOS: disconnect native voice
    if (useNativeVoice()) {
      nativeVoiceDisconnect();
    }

    // Stop native foreground service (mobile only)
    stopVoiceCallService();

    // Send unwatch WS events for all active screen share watches before clearing
    const { watchingScreenShares, _wsSend, currentVoiceChannelId, voiceStates } = get();
    if (_wsSend) {
      for (const streamerId of Object.keys(watchingScreenShares)) {
        _wsSend("screen_share_watch", { streamer_user_id: streamerId, watching: false });
      }
    }

    // Proactively scrub our own entry from the participant map. The server's
    // voice_state_update(leave) may never reach us — e.g. when leaving a server
    // removes us from that server's broadcast index before the voice leave fires.
    // Without this, rejoining the server would show ourselves as a phantom voice
    // participant until another event rebuilds the map.
    let newVoiceStates = voiceStates;
    if (currentVoiceChannelId && voiceStates[currentVoiceChannelId]) {
      const ownId = getOwnUserId();
      if (ownId) {
        const filtered = voiceStates[currentVoiceChannelId].filter((s) => s.user_id !== ownId);
        newVoiceStates = { ...voiceStates };
        if (filtered.length === 0) {
          delete newVoiceStates[currentVoiceChannelId];
        } else {
          newVoiceStates[currentVoiceChannelId] = filtered;
        }
      }
    }

    // Stop the "Akıcı Görüntü" helper if it's running (it outlives the JS otherwise).
    if (get().isNativeCapturing) {
      void window.electronAPI?.stopGameCapture();
    }

    set({
      voiceStates: newVoiceStates,
      currentVoiceChannelId: null,
      currentVoiceServerId: null,
      livekitUrl: null,
      livekitToken: null,
      e2eePassphrase: null,
      // isMuted/isDeafened intentionally NOT reset — they persist across sessions
      isStreaming: false,
      isNativeCapturing: false,
  pickedShareSourceId: null,
      isServerMuted: false,
      isServerDeafened: false,
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
      if (useNativeVoice()) {
        nativeVoiceSetDeafened(false);
        nativeVoiceSetMic(isMuted); // was muted, now toggling
      }
    } else {
      set({ isMuted: !isMuted });
      if (useNativeVoice()) {
        nativeVoiceSetMic(isMuted); // was muted → enable, was unmuted → disable
      }
    }
    saveMuteState({ isMuted: get().isMuted, isDeafened: get().isDeafened });
    if (get().isMuted) playMuteOnSound();
    else playMuteOffSound();
  },

  toggleDeafen: () => {
    const { isDeafened } = get();

    if (!isDeafened) {
      // Deafen on -> mute also on (Discord behavior)
      set({ isDeafened: true, isMuted: true });
      if (useNativeVoice()) {
        nativeVoiceSetDeafened(true);
        nativeVoiceSetMic(false);
      }
    } else {
      // Deafen off -> unmute too (Discord behavior)
      set({ isDeafened: false, isMuted: false });
      if (useNativeVoice()) {
        nativeVoiceSetDeafened(false);
        nativeVoiceSetMic(true);
      }
    }
    saveMuteState({ isMuted: get().isMuted, isDeafened: get().isDeafened });
    if (get().isDeafened) playDeafenOnSound();
    else playDeafenOffSound();
  },

  setStreaming: (isStreaming: boolean) => {
    set({ isStreaming });
  },

  startNativeSmoothCapture: async (sourceId: string) => {
    const serverId = useServerStore.getState().activeServerId;
    const channelId = get().currentVoiceChannelId;
    if (!serverId || !channelId || !window.electronAPI) return false;
    // Before the token round-trip, not after: the helper is Windows-only, so anywhere else this
    // would mint a screen-share token and hand the room passphrase to a path that only rejects it.
    if (window.electronAPI.platform !== "win32") return false;

    // Screen-token = the {userId}_ss identity + the room's E2EE passphrase; the native helper
    // publishes with these, so it decrypts on every client exactly like any screen share.
    const resp = await voiceApi.getScreenShareToken(serverId, channelId);
    if (!resp.success || !resp.data?.e2ee_passphrase) {
      console.error("[voice] smooth capture: screen-token failed", resp.error);
      return false;
    }
    const { url, token, e2ee_passphrase } = resp.data;
    // Resolves only once the helper is really publishing — a false here means nothing was ever
    // on the wire, so the caller can still fall back to sharp.
    const res = await window.electronAPI.startGameCapture({
      url,
      token,
      e2eePassphrase: e2ee_passphrase,
      sourceId,
      // The same setting "Net Görüntü" already honours — a cap on the stream, not the capture.
      maxHeight: get().screenShareQuality === "720p" ? 720 : 1080,
    });
    if (!res.started) {
      console.error("[voice] smooth capture failed to start:", res.error);
      return false;
    }
    // Presence is derived from (isStreaming || isNativeCapturing) in VoiceStateManager — one
    // sharing concept, two engines — so nothing to broadcast here.
    set({ isNativeCapturing: true });
    return true;
  },

  stopNativeSmoothCapture: () => {
    void window.electronAPI?.stopGameCapture();
    set({ isNativeCapturing: false });
  },

  setPickedShareSourceId: (sourceId) => {
    set({ pickedShareSourceId: sourceId });
  },

  setRtt: (rtt) => set({ rtt }),

  setActiveSpeakers: (speakerIds) => {
    const map: Record<string, boolean> = {};
    for (const id of speakerIds) {
      map[id] = true;
    }
    set({ activeSpeakers: map });
  },
}));
