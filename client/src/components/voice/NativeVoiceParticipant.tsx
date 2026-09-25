/**
 * NativeVoiceParticipant — a participant of the native iOS room. The page holds no LiveKit
 * participant for it (its JS room never connects there), so speaking comes from the speakers the
 * native room reports into voiceStore.activeSpeakers.
 */

import { useVoiceStore } from "../../stores/voiceStore";
import VoiceParticipantTile from "./VoiceParticipantTile";

type NativeVoiceParticipantProps = {
  userId: string;
  /** Compact mode for screen share strip */
  compact?: boolean;
};

function NativeVoiceParticipant({ userId, compact = false }: NativeVoiceParticipantProps) {
  const rawSpeaking = useVoiceStore((s) => s.activeSpeakers[userId] ?? false);
  return <VoiceParticipantTile userId={userId} rawSpeaking={rawSpeaking} compact={compact} />;
}

export default NativeVoiceParticipant;
