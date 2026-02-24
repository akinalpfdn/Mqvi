/**
 * voiceStore — Voice (ses kanalı) state yönetimi.
 *
 * Zustand slice store pattern'i ile organize edilir.
 *
 * Sorumluluklar:
 * 1. voiceStates: Hangi kullanıcılar hangi ses kanallarında → sidebar gösterimi
 * 2. currentVoiceChannelId: Aktif ses kanalı (null = bağlı değil)
 * 3. isMuted / isDeafened / isStreaming: Lokal kontrol state'leri
 * 4. livekitUrl / livekitToken: LiveKit bağlantı bilgileri
 * 5. WS event handler'ları (voice_state_update, voice_states_sync)
 * 6. Voice settings: inputMode, PTT key, mic sensitivity, device selection, volumes
 *    → localStorage'da persist edilir (sayfa yenilemede korunur)
 *
 * Discord davranışları:
 * - Mute toggle: deafen edilmişse mute kapatılamaz (deafen > mute)
 * - Deafen toggle: deafen açılınca mute da açılır, deafen kapatılınca mute kalır
 * - Bir kullanıcı aynı anda tek bir ses kanalında olabilir
 */

import { create } from "zustand";
import type { VoiceState, VoiceStateUpdateData, VoiceTokenResponse } from "../types";
import * as voiceApi from "../api/voice";

// ─── localStorage Persistence ───

/**
 * Voice ayarları localStorage key'i.
 * Prefix ile namespace'lenir — başka uygulamalarla çakışma olmaz.
 */
const STORAGE_KEY = "mqvi_voice_settings";

/**
 * VoiceSettings — localStorage'da persist edilen voice ayarları.
 *
 * Bu tip, voiceStore'daki transient state'lerden (voiceStates, livekitUrl vb.)
 * ayrı tutulur. Sadece kullanıcı tercihleri persist edilir.
 */
type VoiceSettings = {
  inputMode: InputMode;
  pttKey: string;
  micSensitivity: number;
  userVolumes: Record<string, number>;
  inputDevice: string;
  outputDevice: string;
  masterVolume: number;
  soundsEnabled: boolean;
};

/**
 * InputMode — Mikrofon giriş modu.
 * - voice_activity: Ses algılandığında otomatik iletim (varsayılan)
 * - push_to_talk: Belirli tuş basılı tutulurken iletim
 */
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
};

/**
 * loadSettings — localStorage'dan voice ayarlarını yükler.
 *
 * JSON parse hatası veya eksik key durumunda default değerler kullanılır.
 * Partial merge yapılır: localStorage'da olmayan key'ler default'tan gelir.
 * Bu sayede yeni ayar eklendiğinde eski kullanıcıların localStorage'ı bozulmaz.
 */
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

/**
 * saveSettings — Voice ayarlarını localStorage'a kaydeder.
 *
 * Her setter action'ında çağrılır. Tüm settings bir arada saklanır —
 * tek key ile atomic write yapılır (partial update yok).
 */
function saveSettings(settings: VoiceSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage dolu veya erişilemez — sessizce devam et
  }
}

/** Store init'te bir kez yüklenir */
const initialSettings = loadSettings();

export type { InputMode };

type VoiceStore = {
  /**
   * channelId → VoiceState[] mapping.
   * Map yerine Record kullanılır — Zustand JSON serialize için daha uyumlu.
   */
  voiceStates: Record<string, VoiceState[]>;

  /** Kullanıcının bağlı olduğu ses kanalı ID'si (null = bağlı değil) */
  currentVoiceChannelId: string | null;

  /** Lokal mute durumu (mikrofon kapalı) */
  isMuted: boolean;

  /** Lokal deafen durumu (ses çıkışı kapalı) */
  isDeafened: boolean;

  /** Lokal screen share durumu */
  isStreaming: boolean;

  /** LiveKit bağlantı URL'i (ws://...) */
  livekitUrl: string | null;

  /** LiveKit JWT token'ı */
  livekitToken: string | null;

  // ─── Voice Settings (persisted) ───

  /**
   * inputMode — Mikrofon giriş modu.
   * "voice_activity": Ses algılandığında otomatik iletim
   * "push_to_talk": Belirli tuş basılı tutulurken iletim
   */
  inputMode: InputMode;

  /**
   * pttKey — Push-to-talk tuşu.
   * KeyboardEvent.code değeri kullanılır (örn: "Space", "KeyV", "ControlLeft").
   * code, fiziksel tuşu temsil eder — klavye layout'undan bağımsızdır.
   */
  pttKey: string;

  /**
   * micSensitivity — Mikrofon hassasiyeti (0-100).
   * 0 = en düşük hassasiyet (çok ses gerekir), 100 = en yüksek (fısıltı bile algılanır).
   * LiveKit'in WebRTC audio constraint'lerine map edilir.
   */
  micSensitivity: number;

  /**
   * userVolumes — Kullanıcı bazlı ses seviyeleri.
   * userId → volume (0-200, default 100).
   * 0 = sessiz, 100 = normal, 200 = 2x amplified.
   */
  userVolumes: Record<string, number>;

  /** inputDevice — Seçili mikrofon device ID'si (MediaDeviceInfo.deviceId) */
  inputDevice: string;

  /** outputDevice — Seçili hoparlör device ID'si */
  outputDevice: string;

  /**
   * masterVolume — Ana ses seviyesi (0-100).
   * Tüm remote audio'nun genel seviyesini kontrol eder.
   */
  masterVolume: number;

  /** soundsEnabled — Kanal giriş/çıkış sesleri açık mı? */
  soundsEnabled: boolean;

  /**
   * rtt — LiveKit signal server'a round-trip time (ms).
   * VoiceStateManager tarafından periyodik olarak güncellenir.
   * 0 = henüz ölçülmedi veya bağlı değil.
   */
  rtt: number;

  // ─── Actions ───

  /**
   * joinVoiceChannel — Ses kanalına katılır.
   * 1. API'den LiveKit token alır
   * 2. Store state'ini günceller (livekitUrl, livekitToken, currentVoiceChannelId)
   * Not: WS voice_join event'i ayrıca gönderilir (useVoice hook'unda)
   */
  joinVoiceChannel: (channelId: string) => Promise<VoiceTokenResponse | null>;

  /**
   * leaveVoiceChannel — Ses kanalından ayrılır.
   * Store state'ini temizler.
   * Not: WS voice_leave event'i ayrıca gönderilir (useVoice hook'unda)
   */
  leaveVoiceChannel: () => void;

  /**
   * toggleMute — Mikrofon açma/kapama.
   * Discord davranışı: deafen edilmişse önce deafen kapatılır.
   */
  toggleMute: () => void;

  /**
   * toggleDeafen — Ses çıkışı açma/kapama.
   * Discord davranışı: deafen açılınca mute da açılır.
   */
  toggleDeafen: () => void;

  /** setStreaming — Screen share durumunu günceller */
  setStreaming: (isStreaming: boolean) => void;

  // ─── Voice Settings Actions ───

  setInputMode: (mode: InputMode) => void;
  setPTTKey: (key: string) => void;
  setMicSensitivity: (value: number) => void;
  setUserVolume: (userId: string, volume: number) => void;
  setInputDevice: (deviceId: string) => void;
  setOutputDevice: (deviceId: string) => void;
  setMasterVolume: (value: number) => void;
  setSoundsEnabled: (enabled: boolean) => void;
  setRtt: (rtt: number) => void;

  // ─── Cross-store Callback ───

  /**
   * _onLeaveCallback — Tab close'dan tetiklenen voice leave callback'i.
   *
   * Bu field, useVoice hook'undaki leaveVoice() fonksiyonunu tutar.
   * uiStore.closeTab bir voice tab'ı kapattığında bu callback çağrılır —
   * böylece hem WS voice_leave event'i gönderilir hem de store temizlenir.
   *
   * Neden doğrudan leaveVoiceChannel çağırmıyoruz?
   * Çünkü leaveVoiceChannel sadece store'u temizler — WS event göndermez.
   * Backend'in kullanıcının ayrıldığını bilmesi için WS event şart.
   *
   * registerOnLeave: AppLayout'ta useVoice hook oluşturulduktan sonra çağrılır.
   */
  _onLeaveCallback: (() => void) | null;
  registerOnLeave: (fn: (() => void) | null) => void;

  // ─── WS Event Handlers ───

  /**
   * handleVoiceStateUpdate — voice_state_update WS event handler.
   * join/leave/update action'a göre voiceStates map'ini günceller.
   */
  handleVoiceStateUpdate: (data: VoiceStateUpdateData) => void;

  /**
   * handleVoiceStatesSync — voice_states_sync WS event handler.
   * Bağlantı kurulduğunda tüm aktif voice state'leri bulk sync eder.
   */
  handleVoiceStatesSync: (states: VoiceState[]) => void;
};

export const useVoiceStore = create<VoiceStore>((set, get) => ({
  voiceStates: {},
  currentVoiceChannelId: null,
  isMuted: false,
  isDeafened: false,
  isStreaming: false,
  livekitUrl: null,
  livekitToken: null,

  // ─── Voice Settings (localStorage'dan yüklenir) ───
  inputMode: initialSettings.inputMode,
  pttKey: initialSettings.pttKey,
  micSensitivity: initialSettings.micSensitivity,
  userVolumes: initialSettings.userVolumes,
  inputDevice: initialSettings.inputDevice,
  outputDevice: initialSettings.outputDevice,
  masterVolume: initialSettings.masterVolume,
  soundsEnabled: initialSettings.soundsEnabled,
  rtt: 0,

  // ─── Cross-store Callback ───
  _onLeaveCallback: null,
  registerOnLeave: (fn) => set({ _onLeaveCallback: fn }),

  // ─── Actions ───

  joinVoiceChannel: async (channelId: string) => {
    try {
      const response = await voiceApi.getVoiceToken(channelId);

      if (!response.success || !response.data) {
        console.error("[voiceStore] Failed to get voice token:", response.error);
        return null;
      }

      console.log("[voiceStore] Voice token obtained, connecting to:", response.data.url);

      // PTT modunda mic kapalı başlar (tuş basıldığında açılır).
      // Voice activity modunda mic açık başlar (normal davranış).
      const startMuted = get().inputMode === "push_to_talk";

      set({
        currentVoiceChannelId: channelId,
        livekitUrl: response.data.url,
        livekitToken: response.data.token,
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
    set({
      currentVoiceChannelId: null,
      livekitUrl: null,
      livekitToken: null,
      isMuted: false,
      isDeafened: false,
      isStreaming: false,
      rtt: 0,
    });
  },

  toggleMute: () => {
    const { isMuted, isDeafened } = get();

    if (isDeafened) {
      // Deafen açıkken mute toggle → deafen'ı kapat, mute durumunu çevir
      set({ isDeafened: false, isMuted: !isMuted });
    } else {
      set({ isMuted: !isMuted });
    }
  },

  toggleDeafen: () => {
    const { isDeafened } = get();

    if (!isDeafened) {
      // Deafen açılıyor → mute da açılır (Discord davranışı)
      set({ isDeafened: true, isMuted: true });
    } else {
      // Deafen kapatılıyor → mute kalır (kullanıcı isterse ayrıca kapatır)
      set({ isDeafened: false });
    }
  },

  setStreaming: (isStreaming: boolean) => {
    set({ isStreaming });
  },

  // ─── Voice Settings Actions ───
  // Her setter, güncel settings'i okuyup localStorage'a yazar.
  // Bu pattern "read-modify-write" ile atomic persist sağlar.

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
    });
  },

  setRtt: (rtt) => set({ rtt }),

  // ─── WS Event Handlers ───

  handleVoiceStateUpdate: (data: VoiceStateUpdateData) => {
    set((state) => {
      const newStates = { ...state.voiceStates };

      switch (data.action) {
        case "join": {
          // Kullanıcıyı eski kanallardan temizle (birden fazla kanalda olamaz)
          for (const channelId of Object.keys(newStates)) {
            newStates[channelId] = newStates[channelId].filter(
              (s) => s.user_id !== data.user_id
            );
            if (newStates[channelId].length === 0) {
              delete newStates[channelId];
            }
          }

          // Yeni kanala ekle
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
            },
          ];
          break;
        }

        case "leave": {
          // Kullanıcıyı kanaldan çıkar
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
          // Kullanıcının state'ini güncelle
          if (newStates[data.channel_id]) {
            newStates[data.channel_id] = newStates[data.channel_id].map((s) =>
              s.user_id === data.user_id
                ? {
                    ...s,
                    is_muted: data.is_muted,
                    is_deafened: data.is_deafened,
                    is_streaming: data.is_streaming,
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
    // Tüm state'leri channelId'ye göre grupla
    const grouped: Record<string, VoiceState[]> = {};

    for (const state of states) {
      if (!grouped[state.channel_id]) {
        grouped[state.channel_id] = [];
      }
      grouped[state.channel_id].push(state);
    }

    set({ voiceStates: grouped });
  },
}));
