/**
 * VoiceParticipantGrid — Renders all participants in the voice room.
 *
 * Two modes:
 * 1. Full (no screen share): flex-1, participants in centered grid
 * 2. Compact (screen share active): fixed-height strip at bottom
 *
 * Uses voiceStore.watchingScreenShares instead of useTracks to avoid
 * adding ~6 internal listeners per useTracks call.
 */

import { useMemo } from "react";
import { useParticipants } from "@livekit/components-react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { isScreenShareIdentity } from "../../utils/constants";
import VoiceParticipant from "./VoiceParticipant";

function VoiceParticipantGrid() {
  const { t } = useTranslation("voice");
  const allParticipants = useParticipants();

  // Filter out iOS native screen share sub-participants (identity ends with "_ss").
  // They are separate LiveKit connections that only publish screen share tracks.
  const participants = useMemo(
    () => allParticipants.filter((p) => !isScreenShareIdentity(p.identity)),
    [allParticipants]
  );

  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);
  const hasScreenShare = Object.values(watchingScreenShares).some(Boolean);

  if (participants.length === 0) {
    // Don't show empty message when screen share is active
    if (hasScreenShare) return null;

    return (
      <div className="voice-room-loading">
        <p>{t("noOneInVoice")}</p>
      </div>
    );
  }

  // Compact strip below screen share
  if (hasScreenShare) {
    return (
      <div className="voice-grid-strip">
        {participants.map((participant) => (
          <VoiceParticipant
            key={participant.identity}
            participant={participant}
            compact
          />
        ))}
      </div>
    );
  }

  // Full grid
  return (
    <div className="voice-room-grid">
      {participants.map((participant) => (
        <VoiceParticipant
          key={participant.identity}
          participant={participant}
        />
      ))}
    </div>
  );
}

export default VoiceParticipantGrid;
