/**
 * Soundboard store — manages soundboard sounds per server.
 * Volume and muted state persisted to localStorage.
 */

import { create } from "zustand";
import type { SoundboardSound, SoundboardPlayEvent } from "../types";
import * as soundboardApi from "../api/soundboard";
import { useVoiceStore } from "./voiceStore";
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

// The currently-playing soundboard audio, kept at module scope (not store state)
// so it can be stopped imperatively. Without a handle there is no way to stop a
// sound — a long/spammed clip would play to the end, unstoppable.
let currentAudio: HTMLAudioElement | null = null;
// Monotonic play token — identifies the latest play so a previous play's
// timeout/ended can't clear a newer play's "now playing" indicator.
let playSeq = 0;
function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
}

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
  stopPlayback: () => void;

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

  // Every server the user is in, not just the one on screen: you are routinely in a voice
  // channel of one server while looking at another, and the sound you want is in a third.
  fetchSounds: async () => {
    set({ isLoading: true });
    const res = await soundboardApi.getAllSounds();
    if (res.success && res.data) {
      set({ sounds: res.data, isLoading: false });
    } else {
      set({ isLoading: false });
    }
  },

  // The sound's own server, never the one on screen — they are not the same thing any more.
  // The server then decides whether it may be played into the voice channel the user is in.
  playSound: async (soundId: string) => {
    const sound = get().sounds.find((s) => s.id === soundId);
    if (!sound) return;
    await soundboardApi.playSound(sound.server_id, soundId);
  },

  togglePanel: () => {
    const wasOpen = get().isPanelOpen;
    set({ isPanelOpen: !wasOpen });
    if (!wasOpen && get().sounds.length === 0) {
      get().fetchSounds();
    }
  },

  closePanel: () => set({ isPanelOpen: false }),

  stopPlayback: () => {
    stopCurrentAudio();
    set({ playingSound: null });
  },

  setVolume: (v) => {
    set({ volume: v });
    if (currentAudio) currentAudio.volume = v; // apply live to the playing clip
    saveSettings(v, get().muted);
  },

  toggleMuted: () => {
    const next = !get().muted;
    set({ muted: next });
    if (currentAudio) currentAudio.volume = next ? 0 : get().volume; // live mute/unmute
    saveSettings(get().volume, next);
  },

  // These three used to drop anything that was not the server on screen, back when the panel
  // only held that server's sounds. It now holds every server the user is in, and the events
  // only reach members of the server they came from — so the sound belongs in the list no
  // matter which server the user happens to be looking at.
  handleSoundCreate: (sound) => {
    set((s) => ({ sounds: [...s.sounds, sound] }));
  },

  handleSoundUpdate: (sound) => {
    set((s) => ({
      sounds: s.sounds.map((existing) =>
        existing.id === sound.id ? sound : existing
      ),
    }));
  },

  handleSoundDelete: (data) => {
    set((s) => ({
      sounds: s.sounds.filter((sound) => sound.id !== data.id),
    }));
  },

  handleSoundPlay: (data) => {
    // No server check. A sound played into this voice channel can come from ANY server the
    // player is in, and the listeners are usually looking at some other server entirely —
    // matching on the sound's server here silently dropped the event and nobody heard it.
    //
    // The channel is the check that means something: the server already targets the
    // participants, and this covers the moment right after leaving, so a sound never plays
    // for a channel we are no longer in.
    const myChannel = useVoiceStore.getState().currentVoiceChannelId;
    if (myChannel !== data.channel_id) return;

    // Single active sound: stop any previous clip first, so spam can't stack
    // overlapping (unstoppable) audio and the latest is always the one playing.
    stopCurrentAudio();
    const seq = ++playSeq;

    set({
      playingSound: {
        soundId: data.sound_id,
        userId: data.user_id,
        username: data.username,
      },
    });

    const { muted, volume } = get();
    if (!muted && volume > 0) {
      const audio = new Audio(`${SERVER_URL}${data.sound_url}`);
      audio.volume = volume;
      currentAudio = audio;
      audio.addEventListener("ended", () => {
        if (currentAudio === audio) currentAudio = null;
        if (playSeq === seq) set({ playingSound: null });
      });
      audio.play().catch(() => {
        // Play never started → no 'ended' will fire; drop the stale handle.
        if (currentAudio === audio) currentAudio = null;
      });
    }

    // Fallback clear of the indicator (e.g. when muted, no 'ended' fires).
    // Guarded by the play token so an older play can't clear a newer one.
    const sound = get().sounds.find((s) => s.id === data.sound_id);
    const duration = sound?.duration_ms ?? 3000;
    setTimeout(() => {
      if (playSeq === seq) set({ playingSound: null });
    }, duration + 200);
  },

  // Still drops the list, even though it is no longer scoped to one server: this also closes
  // the panel, and the panel refetches when it is next opened — so nothing goes stale. It is
  // also, in practice, what clears one user's sounds out of the next one's session, since the
  // SPA never reloads on logout and nothing else resets this store.
  clearForServerSwitch: () => {
    stopCurrentAudio();
    set({ sounds: EMPTY, isPanelOpen: false, playingSound: null });
  },
}));

// Stop any playing soundboard audio the moment the user leaves or switches voice
// channel — a sound must not keep playing after you've left the call.
useVoiceStore.subscribe((state, prev) => {
  if (state.currentVoiceChannelId !== prev.currentVoiceChannelId) {
    stopCurrentAudio();
    useSoundboardStore.setState({ playingSound: null });
  }
});
