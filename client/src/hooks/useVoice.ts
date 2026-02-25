/**
 * useVoice — Voice join/leave orchestration hook'u.
 *
 * Bu hook, voice kanalına katılma/ayrılma sürecini koordine eder:
 * 1. voiceStore action'larını çağırır (API token + store state)
 * 2. WS event'lerini gönderir (voice_join / voice_leave / voice_state_update_request)
 *
 * Neden ayrı bir hook?
 * - voiceStore yalnızca state yönetiminden sorumlu (Single Responsibility)
 * - useWebSocket yalnızca WS bağlantısından sorumlu
 * - Bu hook ikisini birleştirir (orkestrasyon katmanı)
 *
 * Bu hook ChatArea veya Sidebar'da kullanılır — component'e göre değişir.
 */

import { useCallback } from "react";
import { useVoiceStore } from "../stores/voiceStore";

type VoiceActions = {
  /** Ses kanalına katıl: token al → store güncelle → WS event gönder */
  joinVoice: (channelId: string) => Promise<void>;

  /** Ses kanalından ayrıl: store temizle → WS event gönder */
  leaveVoice: () => void;

  /** Mute toggle: store güncelle → WS state update gönder */
  toggleMute: () => void;

  /** Deafen toggle: store güncelle → WS state update gönder */
  toggleDeafen: () => void;

  /** Screen share toggle: store güncelle → WS state update gönder */
  toggleScreenShare: () => void;
};

type UseVoiceParams = {
  sendVoiceJoin: (channelId: string) => void;
  sendVoiceLeave: () => void;
  sendVoiceStateUpdate: (state: {
    is_muted?: boolean;
    is_deafened?: boolean;
    is_streaming?: boolean;
  }) => void;
};

export function useVoice({
  sendVoiceJoin,
  sendVoiceLeave,
  sendVoiceStateUpdate,
}: UseVoiceParams): VoiceActions {
  const joinVoiceChannel = useVoiceStore((s) => s.joinVoiceChannel);
  const leaveVoiceChannel = useVoiceStore((s) => s.leaveVoiceChannel);
  const storeToggleMute = useVoiceStore((s) => s.toggleMute);
  const storeToggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const storeSetStreaming = useVoiceStore((s) => s.setStreaming);

  const joinVoice = useCallback(
    async (channelId: string) => {
      const currentChannel = useVoiceStore.getState().currentVoiceChannelId;

      // Zaten bu kanaldayız — tekrar katılma.
      // openTab() zaten mevcut tab'ı focus eder, burada da erken çıkıyoruz.
      if (currentChannel === channelId) return;

      // Farklı bir kanaldayız — önce ayrıl.
      // 1. WS voice_leave gönder → backend eski kanaldan çıkar
      // 2. Store state temizle → currentVoiceChannelId = null
      // React re-render tetiklenir → AppLayout effect eski voice tab'larını kapatır.
      // await joinVoiceChannel'daki async break sayesinde React bu re-render'ı
      // işler → eski tab'lar temizlenir, sonra yeni kanal kurulur.
      if (currentChannel) {
        sendVoiceLeave();
        leaveVoiceChannel();
      }

      // Yeni kanala katıl: API'den token al + store state güncelle
      const tokenData = await joinVoiceChannel(channelId);
      if (!tokenData) return;

      // WS voice_join event'i gönder (backend in-memory state güncellemesi)
      sendVoiceJoin(channelId);
    },
    [joinVoiceChannel, leaveVoiceChannel, sendVoiceJoin, sendVoiceLeave]
  );

  const leaveVoice = useCallback(() => {
    // 1. WS voice_leave event'i gönder (backend state temizleme)
    sendVoiceLeave();

    // 2. Store state'ini temizle
    leaveVoiceChannel();
  }, [leaveVoiceChannel, sendVoiceLeave]);

  const toggleMute = useCallback(() => {
    storeToggleMute();

    // Store güncellendikten sonra güncel state'i oku ve WS'e gönder
    const { isMuted, isDeafened } = useVoiceStore.getState();
    sendVoiceStateUpdate({ is_muted: isMuted, is_deafened: isDeafened });
  }, [storeToggleMute, sendVoiceStateUpdate]);

  const toggleDeafen = useCallback(() => {
    storeToggleDeafen();

    // Store güncellendikten sonra güncel state'i oku ve WS'e gönder
    const { isMuted, isDeafened } = useVoiceStore.getState();
    sendVoiceStateUpdate({ is_muted: isMuted, is_deafened: isDeafened });
  }, [storeToggleDeafen, sendVoiceStateUpdate]);

  const toggleScreenShare = useCallback(() => {
    const { isStreaming } = useVoiceStore.getState();
    const newStreaming = !isStreaming;
    storeSetStreaming(newStreaming);

    // WS state update gönder — server-side stream limit kontrolü yapılır
    sendVoiceStateUpdate({ is_streaming: newStreaming });
  }, [storeSetStreaming, sendVoiceStateUpdate]);

  return { joinVoice, leaveVoice, toggleMute, toggleDeafen, toggleScreenShare };
}
