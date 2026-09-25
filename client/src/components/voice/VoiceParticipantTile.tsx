/**
 * VoiceParticipantTile — Single participant tile in the voice room.
 *
 * Two display modes:
 * - Full (compact=false): 64px avatar + name below — default grid layout
 * - Compact (compact=true): 32px avatar + name beside — screen share strip
 *
 * Right-click opens VoiceUserContextMenu (volume slider, local/server mute/deafen).
 * No context menu for the local user.
 *
 * Name, avatar and mute/deafen come from the server's voice states. Whether the user is speaking
 * comes from the caller: the JS LiveKit room (VoiceParticipant) or the native iOS room
 * (NativeVoiceParticipant).
 * Visual states: speaking = green ring, muted = mic-off overlay, deafened = headphone-off overlay.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAuthStore } from "../../stores/authStore";
import { useSoundboardStore } from "../../stores/soundboardStore";
import { IconHeadphonesMuted, IconMicMuted } from "../shared/Icons";
import VoiceUserContextMenu from "./VoiceUserContextMenu";
import { resolveAssetUrl } from "../../utils/constants";

type VoiceParticipantTileProps = {
  userId: string;
  /** Speaking as reported, before the hold that stops the ring flickering between syllables. */
  rawSpeaking: boolean;
  /** Shown when the server has no voice state for the user yet. */
  fallbackName?: string;
  /** Compact mode for screen share strip */
  compact?: boolean;
};

/** Hold duration to avoid flickering between syllables (~Discord's 250-350ms) */
const SPEAKING_HOLD_MS = 150;

function VoiceParticipantTile({ userId, rawSpeaking, fallbackName, compact = false }: VoiceParticipantTileProps) {
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
    (s) => s.user_id === userId
  );

  const displayName =
    voiceState?.display_name || voiceState?.username || fallbackName || userId;
  const firstLetter = displayName.charAt(0).toUpperCase();
  const avatarUrl = voiceState?.avatar_url || "";
  const isMuted = voiceState?.is_muted ?? false;
  const isDeafened = voiceState?.is_deafened ?? false;

  const isLocalUser = userId === currentUserId;
  const playingSound = useSoundboardStore((s) => s.playingSound);
  const isPlayingSound = playingSound?.userId === userId;

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
      {isDeafened
        ? <IconHeadphonesMuted strokeWidth={2.5} />
        : <IconMicMuted strokeWidth={2.5} />
      }
    </div>
  ) : null;

  const contextMenu = ctxMenu ? (
    <VoiceUserContextMenu
      userId={userId}
      username={voiceState?.username ?? fallbackName ?? userId}
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

export default VoiceParticipantTile;
