/**
 * Soundboard store — manages soundboard sounds per server.
 */

import { create } from "zustand";
import type { SoundboardSound, SoundboardPlayEvent } from "../types";
import * as soundboardApi from "../api/soundboard";
import { useServerStore } from "./serverStore";
import { SERVER_URL } from "../utils/constants";

const EMPTY: SoundboardSound[] = [];

type SoundboardState = {
  sounds: SoundboardSound[];
  isLoading: boolean;
  isPanelOpen: boolean;
  /** Currently playing sound info (for visual feedback) */
  playingSound: { soundId: string; userId: string; username: string } | null;

  // Actions
  fetchSounds: () => Promise<void>;
  playSound: (soundId: string) => Promise<void>;
  togglePanel: () => void;
  closePanel: () => void;

  // WS event handlers
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

    // Show who is playing
    set({
      playingSound: {
        soundId: data.sound_id,
        userId: data.user_id,
        username: data.username,
      },
    });

    // Play the audio locally
    const audio = new Audio(`${SERVER_URL}${data.sound_url}`);
    audio.volume = 0.5;
    audio.play().catch(() => {
      // Browser may block autoplay — ignore
    });

    // Clear playing state after duration
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
