/**
 * VoiceParticipant — Single participant tile in the voice room.
 *
 * Two display modes:
 * - Full (compact=false): 64px avatar + name below — default grid layout
 * - Compact (compact=true): 32px avatar + name beside — screen share strip
 *
 * Right-click opens VoiceUserContextMenu (volume slider, local/server mute/deafen).
 * No context menu for the local user.
 *
 * Speaking detection uses voiceStore.activeSpeakers (updated by VoiceStateManager).
 * Visual states: speaking = green ring, muted = mic-off overlay, deafened = headphone-off overlay.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useIsSpeaking } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAuthStore } from "../../stores/authStore";
import { useSoundboardStore } from "../../stores/soundboardStore";
import VoiceUserContextMenu from "./VoiceUserContextMenu";
import { resolveAssetUrl } from "../../utils/constants";

type VoiceParticipantProps = {
  participant: Participant;
  /** Compact mode for screen share strip */
  compact?: boolean;
};

/** Hold duration to avoid flickering between syllables (~Discord's 250-350ms) */
const SPEAKING_HOLD_MS = 150;

function VoiceParticipant({ participant, compact = false }: VoiceParticipantProps) {
  // LOCAL: analyzed via local AnalyserNode (instant). REMOTE: from SFU speaker info.
  const rawSpeaking = useIsSpeaking(participant);

  // Hold timer: when rawSpeaking goes false, wait SPEAKING_HOLD_MS before hiding indicator.
  // If rawSpeaking goes true again within that window, timer is cancelled.
  const [isSpeaking, setIsSpeaking] = useState(false);
  const holdTimerRef = useRef<number>(0);

  useEffect(() => {
    if (rawSpeaking) {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = 0;
      }
      setIsSpeaking(true);
    } else {
      if (!holdTimerRef.current) {
        holdTimerRef.current = window.setTimeout(() => {
          setIsSpeaking(false);
          holdTimerRef.current = 0;
        }, SPEAKING_HOLD_MS);
      }
    }

    return () => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = 0;
      }
    };
  }, [rawSpeaking]);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const channelStates = currentVoiceChannelId
    ? voiceStates[currentVoiceChannelId] ?? []
    : [];
  const voiceState = channelStates.find(
    (s) => s.user_id === participant.identity
  );

  const displayName =
    voiceState?.display_name || voiceState?.username || participant.name || participant.identity;
  const firstLetter = displayName.charAt(0).toUpperCase();
  const avatarUrl = voiceState?.avatar_url || "";
  const isMuted = voiceState?.is_muted ?? false;
  const isDeafened = voiceState?.is_deafened ?? false;

  const isLocalUser = participant.identity === currentUserId;
  const playingSound = useSoundboardStore((s) => s.playingSound);
  const isPlayingSound = playingSound?.userId === participant.identity;

  const avatarClass = `voice-participant-avatar${isSpeaking || isPlayingSound ? " speaking" : ""}`;

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isLocalUser) return;

      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    },
    [isLocalUser]
  );

  const overlay = (isMuted || isDeafened) ? (
    <div className="voice-participant-overlay">
      {isDeafened ? (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 18v-6a9 9 0 0118 0v6M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
        </svg>
      ) : (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
        </svg>
      )}
    </div>
  ) : null;

  const contextMenu = ctxMenu ? (
    <VoiceUserContextMenu
      userId={participant.identity}
      username={voiceState?.username ?? participant.name ?? participant.identity}
      displayName={displayName}
      avatarUrl={avatarUrl}
      position={ctxMenu}
      onClose={() => setCtxMenu(null)}
    />
  ) : null;

  const avatarContent = avatarUrl ? (
    <img
      src={resolveAssetUrl(avatarUrl)}
      alt={displayName}
      style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
    />
  ) : (
    firstLetter
  );

  if (compact) {
    return (
      <>
        <div className="voice-participant-compact" onContextMenu={handleContextMenu}>
          <div className={avatarClass}>
            {avatarContent}
            {overlay}
          </div>
          <span className="voice-participant-name">{displayName}</span>
        </div>
        {contextMenu}
      </>
    );
  }

  return (
    <>
      <div className="voice-participant" onContextMenu={handleContextMenu}>
        <div className={avatarClass}>
          {avatarContent}
          {overlay}
        </div>
        <span className="voice-participant-name">{displayName}</span>
      </div>
      {contextMenu}
    </>
  );
}

export default VoiceParticipant;
