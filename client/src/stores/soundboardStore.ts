/**
 * Soundboard store — manages soundboard sounds per server.
 * Volume and muted state persisted to localStorage.
 */

import { create } from "zustand";
import type { SoundboardSound, SoundboardPlayEvent } from "../types";
import * as soundboardApi from "../api/soundboard";
import { useServerStore } from "./serverStore";
import { SERVER_URL } from "../utils/constants";

const EMPTY: SoundboardSound[] = [];
const STORAGE_KEY = "mqvi_soundboard_settings";

function loadSettings(): { volume: number; muted: boolean } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        volume: typeof parsed.volume === "number" ? parsed.volume : 0.5,
        muted: typeof parsed.muted === "boolean" ? parsed.muted : false,
      };
    }
  } catch { /* ignore */ }
  return { volume: 0.5, muted: false };
}

function saveSettings(volume: number, muted: boolean) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ volume, muted }));
}

const initial = loadSettings();

type SoundboardState = {
  sounds: SoundboardSound[];
  isLoading: boolean;
  isPanelOpen: boolean;
  playingSound: { soundId: string; userId: string; username: string } | null;
  volume: number;
  muted: boolean;

  fetchSounds: () => Promise<void>;
  playSound: (soundId: string) => Promise<void>;
  togglePanel: () => void;
  closePanel: () => void;
  setVolume: (v: number) => void;
  toggleMuted: () => void;

  handleSoundCreate: (sound: SoundboardSound) => void;
  handleSoundUpdate: (sound: SoundboardSound) => void;
  handleSoundDelete: (data: { id: string; server_id: string }) => void;
  handleSoundPlay: (data: SoundboardPlayEvent) => void;

  clearForServerSwitch: () => void;
};

export const useSoundboardStore = create<SoundboardState>((set, get) => ({
  sounds: EMPTY,
  isLoading: false,
  isPanelOpen: false,
  playingSound: null,
  volume: initial.volume,
  muted: initial.muted,

  fetchSounds: async () => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;

    set({ isLoading: true });
    const res = await soundboardApi.getSounds(serverId);
    if (res.success && res.data) {
      set({ sounds: res.data, isLoading: false });
    } else {
      set({ isLoading: false });
    }
  },

  playSound: async (soundId: string) => {
    const serverId = useServerStore.getState().activeServerId;
    if (!serverId) return;
    await soundboardApi.playSound(serverId, soundId);
  },

  togglePanel: () => {
    const wasOpen = get().isPanelOpen;
    set({ isPanelOpen: !wasOpen });
    if (!wasOpen && get().sounds.length === 0) {
      get().fetchSounds();
    }
  },

  closePanel: () => set({ isPanelOpen: false }),

  setVolume: (v) => {
    set({ volume: v });
    saveSettings(v, get().muted);
  },

  toggleMuted: () => {
    const next = !get().muted;
    set({ muted: next });
    saveSettings(get().volume, next);
  },

  handleSoundCreate: (sound) => {
    const serverId = useServerStore.getState().activeServerId;
    if (sound.server_id !== serverId) return;
    set((s) => ({ sounds: [...s.sounds, sound] }));
  },

  handleSoundUpdate: (sound) => {
    const serverId = useServerStore.getState().activeServerId;
    if (sound.server_id !== serverId) return;
    set((s) => ({
      sounds: s.sounds.map((existing) =>
        existing.id === sound.id ? sound : existing
      ),
    }));
  },

  handleSoundDelete: (data) => {
    const serverId = useServerStore.getState().activeServerId;
    if (data.server_id !== serverId) return;
    set((s) => ({
      sounds: s.sounds.filter((sound) => sound.id !== data.id),
    }));
  },

  handleSoundPlay: (data) => {
    const serverId = useServerStore.getState().activeServerId;
    if (data.server_id !== serverId) return;

    const { muted, volume } = get();

    set({
      playingSound: {
        soundId: data.sound_id,
        userId: data.user_id,
        username: data.username,
      },
    });

    // Play audio unless muted
    if (!muted && volume > 0) {
      const audio = new Audio(`${SERVER_URL}${data.sound_url}`);
      audio.volume = volume;
      audio.play().catch(() => {});
    }

    const sound = get().sounds.find((s) => s.id === data.sound_id);
    const duration = sound?.duration_ms ?? 3000;
    setTimeout(() => {
      set((s) =>
        s.playingSound?.soundId === data.sound_id ? { playingSound: null } : s
      );
    }, duration + 200);
  },

  clearForServerSwitch: () => {
    set({ sounds: EMPTY, isPanelOpen: false, playingSound: null });
  },
}));
