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
 *
 * Discord davranışları:
 * - Mute toggle: deafen edilmişse mute kapatılamaz (deafen > mute)
 * - Deafen toggle: deafen açılınca mute da açılır, deafen kapatılınca mute kalır
 * - Bir kullanıcı aynı anda tek bir ses kanalında olabilir
 */

import { create } from "zustand";
import type { VoiceState, VoiceStateUpdateData, VoiceTokenResponse } from "../types";
import * as voiceApi from "../api/voice";

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

  // ─── Actions ───

  joinVoiceChannel: async (channelId: string) => {
    try {
      const response = await voiceApi.getVoiceToken(channelId);

      if (!response.success || !response.data) {
        console.error("[voiceStore] Failed to get voice token:", response.error);
        return null;
      }

      console.log("[voiceStore] Voice token obtained, connecting to:", response.data.url);

      set({
        currentVoiceChannelId: channelId,
        livekitUrl: response.data.url,
        livekitToken: response.data.token,
        // Katılırken mute/deafen sıfırlanır (Discord davranışı)
        isMuted: false,
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
