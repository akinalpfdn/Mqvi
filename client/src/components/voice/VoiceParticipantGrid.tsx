/**
 * VoiceParticipantGrid — Renders all participants in the voice room.
 *
 * Two modes:
 * 1. Full (no screen share): flex-1, participants in centered grid
 * 2. Compact (screen share active): fixed-height strip at bottom
 *
 * Participants come from the JS LiveKit room, except on iOS: voice runs in the native room there
 * and the JS room never connects, so it would list one nameless local participant. The server's
 * voice states for the channel are the list instead, as the sidebar already uses them.
 *
 * Uses voiceStore.watchingScreenShares instead of useTracks to avoid
 * adding ~6 internal listeners per useTracks call.
 */

import { useMemo, type ReactNode } from "react";
import { useParticipants } from "@livekit/components-react";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { isScreenShareIdentity } from "../../utils/constants";
import { useNativeVoice } from "../../utils/nativePlugins";
import type { VoiceState } from "../../types";
import VoiceParticipant from "./VoiceParticipant";
import NativeVoiceParticipant from "./NativeVoiceParticipant";

const NO_STATES: VoiceState[] = [];

type ParticipantLayoutProps = {
  count: number;
  renderTiles: (compact: boolean) => ReactNode;
};

/** The empty message, the compact strip under a screen share, or the full grid. */
function ParticipantLayout({ count, renderTiles }: ParticipantLayoutProps) {
  const { t } = useTranslation("voice");
  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);
  const hasScreenShare = Object.values(watchingScreenShares).some(Boolean);

  if (count === 0) {
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
    return <div className="voice-grid-strip">{renderTiles(true)}</div>;
  }

  // Full grid
  return <div className="voice-room-grid">{renderTiles(false)}</div>;
}

function RoomParticipants() {
  const allParticipants = useParticipants();

  // Filter out iOS native screen share sub-participants (identity ends with "_ss").
  // They are separate LiveKit connections that only publish screen share tracks.
  const participants = useMemo(
    () => allParticipants.filter((p) => !isScreenShareIdentity(p.identity)),
    [allParticipants]
  );

  return (
    <ParticipantLayout
      count={participants.length}
      renderTiles={(compact) =>
        participants.map((participant) => (
          <VoiceParticipant key={participant.identity} participant={participant} compact={compact} />
        ))
      }
    />
  );
}

function NativeParticipants() {
  const states = useVoiceStore((s) =>
    s.currentVoiceChannelId ? s.voiceStates[s.currentVoiceChannelId] ?? NO_STATES : NO_STATES
  );

  return (
    <ParticipantLayout
      count={states.length}
      renderTiles={(compact) =>
        states.map((state) => (
          <NativeVoiceParticipant key={state.user_id} userId={state.user_id} compact={compact} />
        ))
      }
    />
  );
}

function VoiceParticipantGrid() {
  return useNativeVoice() ? <NativeParticipants /> : <RoomParticipants />;
}

export default VoiceParticipantGrid;
