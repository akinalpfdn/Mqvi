/**
 * VoiceParticipant — a participant of the JS LiveKit room (web, Electron, Android).
 * LOCAL speaking is analyzed via a local AnalyserNode (instant); REMOTE comes from SFU speaker info.
 */

import { useIsSpeaking } from "@livekit/components-react";
import type { Participant } from "livekit-client";
import VoiceParticipantTile from "./VoiceParticipantTile";

type VoiceParticipantProps = {
  participant: Participant;
  /** Compact mode for screen share strip */
  compact?: boolean;
};

function VoiceParticipant({ participant, compact = false }: VoiceParticipantProps) {
  const rawSpeaking = useIsSpeaking(participant);
  return (
    <VoiceParticipantTile
      userId={participant.identity}
      rawSpeaking={rawSpeaking}
      fallbackName={participant.name}
      compact={compact}
    />
  );
}

export default VoiceParticipant;
