/**
 * VoiceParticipant — Ses odasında tek bir katılımcı tile'ı.
 *
 * CSS class'ları:
 * - Tam mod: .voice-participant, .voice-participant-avatar, .voice-participant-avatar.speaking,
 *   .voice-participant-name, .voice-participant-overlay
 * - Kompakt mod: .voice-participant-compact (wrapper), aynı alt class'lar küçük boyutta
 *
 * İki boyut modu:
 * - Tam mod (compact=false): 64px avatar + isim altında — screen share yokken
 * - Kompakt mod (compact=true): 32px avatar + isim yanında — screen share strip'i
 *
 * LiveKit'in useIsSpeaking hook'u ile konuşma algılama yapılır.
 * Katılımcının durumuna göre:
 * - Konuşuyorsa: yeşil ring animasyonu
 * - Mute ise: kırmızı mic-off icon overlay
 * - Deafen ise: kırmızı headphone-off icon overlay
 *
 * LiveKit Participant nedir?
 * LiveKit SDK'sında her bağlı kullanıcı bir "Participant" objesidir.
 * useIsSpeaking: Ses algılama (VAD) ile anlık konuşma durumunu döner.
 */

import { useIsSpeaking } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";

type VoiceParticipantProps = {
  participant: Participant;
  /** Kompakt mod — screen share aktifken küçük gösterim */
  compact?: boolean;
};

function VoiceParticipant({ participant, compact = false }: VoiceParticipantProps) {
  const isSpeaking = useIsSpeaking(participant);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const voiceStates = useVoiceStore((s) => s.voiceStates);

  // Bu katılımcının voice state'ini bul (mute/deafen bilgisi)
  const channelStates = currentVoiceChannelId
    ? voiceStates[currentVoiceChannelId] ?? []
    : [];
  const voiceState = channelStates.find(
    (s) => s.user_id === participant.identity
  );

  const displayName = participant.name || participant.identity;
  const firstLetter = displayName.charAt(0).toUpperCase();
  const isMuted = voiceState?.is_muted ?? false;
  const isDeafened = voiceState?.is_deafened ?? false;

  const avatarClass = `voice-participant-avatar${isSpeaking ? " speaking" : ""}`;

  // Mute/Deafen overlay — her iki modda da gösterilir
  const overlay = (isMuted || isDeafened) ? (
    <div className="voice-participant-overlay">
      {isDeafened ? (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728A9 9 0 015.636 5.636" />
        </svg>
      ) : (
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
        </svg>
      )}
    </div>
  ) : null;

  // ─── Kompakt mod: Screen share strip'inde küçük avatar + isim ───
  if (compact) {
    return (
      <div className="voice-participant-compact">
        <div className={avatarClass}>
          {firstLetter}
          {overlay}
        </div>
        <span className="voice-participant-name">{displayName}</span>
      </div>
    );
  }

  // ─── Tam mod: Büyük avatar + isim altında ───
  return (
    <div className="voice-participant">
      <div className={avatarClass}>
        {firstLetter}
        {overlay}
      </div>
      <span className="voice-participant-name">{displayName}</span>
    </div>
  );
}

export default VoiceParticipant;
