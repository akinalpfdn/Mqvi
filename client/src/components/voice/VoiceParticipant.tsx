/**
 * VoiceParticipant — Ses odasında tek bir katılımcı tile'ı.
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
};

function VoiceParticipant({ participant }: VoiceParticipantProps) {
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

  return (
    <div className="flex flex-col items-center gap-2 p-3">
      {/* Avatar — konuşurken yeşil ring */}
      <div className="relative">
        <div
          className={`flex h-16 w-16 items-center justify-center rounded-full bg-brand text-xl font-bold text-white transition-shadow ${
            isSpeaking
              ? "ring-2 ring-status-online ring-offset-2 ring-offset-background"
              : ""
          }`}
        >
          {firstLetter}
        </div>

        {/* Mute / Deafen overlay icon */}
        {(isMuted || isDeafened) && (
          <div className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-background-floating">
            {isDeafened ? (
              <svg className="h-3.5 w-3.5 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728A9 9 0 015.636 5.636" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5 text-danger" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
              </svg>
            )}
          </div>
        )}
      </div>

      {/* Username */}
      <span className="max-w-full truncate text-sm text-text-primary">
        {displayName}
      </span>
    </div>
  );
}

export default VoiceParticipant;
