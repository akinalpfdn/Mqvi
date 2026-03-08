/**
 * useVoice — Voice join/leave orchestration hook.
 *
 * Coordinates between voiceStore (state) and useWebSocket (WS events).
 * Orchestration layer — neither store handles both concerns alone.
 */

import { useCallback } from "react";
import { useVoiceStore } from "../stores/voiceStore";

type VoiceActions = {
  joinVoice: (channelId: string) => Promise<void>;
  leaveVoice: () => void;
  toggleMute: () => void;
  toggleDeafen: () => void;
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

      // Already in this channel
      if (currentChannel === channelId) return;

      // In a different channel — leave first
      if (currentChannel) {
        sendVoiceLeave();
        leaveVoiceChannel();
      }

      const tokenData = await joinVoiceChannel(channelId);
      if (!tokenData) return;

      sendVoiceJoin(channelId);
    },
    [joinVoiceChannel, leaveVoiceChannel, sendVoiceJoin, sendVoiceLeave]
  );

  const leaveVoice = useCallback(() => {
    sendVoiceLeave();
    leaveVoiceChannel();
  }, [leaveVoiceChannel, sendVoiceLeave]);

  const toggleMute = useCallback(() => {
    storeToggleMute();

    const { isMuted, isDeafened } = useVoiceStore.getState();
    sendVoiceStateUpdate({ is_muted: isMuted, is_deafened: isDeafened });
  }, [storeToggleMute, sendVoiceStateUpdate]);

  const toggleDeafen = useCallback(() => {
    storeToggleDeafen();

    const { isMuted, isDeafened } = useVoiceStore.getState();
    sendVoiceStateUpdate({ is_muted: isMuted, is_deafened: isDeafened });
  }, [storeToggleDeafen, sendVoiceStateUpdate]);

  const toggleScreenShare = useCallback(() => {
    const { isStreaming } = useVoiceStore.getState();
    const newStreaming = !isStreaming;
    storeSetStreaming(newStreaming);

    sendVoiceStateUpdate({ is_streaming: newStreaming });
  }, [storeSetStreaming, sendVoiceStateUpdate]);

  return { joinVoice, leaveVoice, toggleMute, toggleDeafen, toggleScreenShare };
}
