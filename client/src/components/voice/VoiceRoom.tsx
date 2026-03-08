/**
 * VoiceRoom — Visual component for the voice channel.
 *
 * Layout (Discord-style):
 * - No screen share: participants fill area as centered grid
 * - Screen share active: screen share takes flex-1, participants show as compact strip below
 *
 * LiveKit connection is managed by VoiceProvider at AppLayout level.
 * This component only renders visuals — mount/unmount won't affect the connection.
 */

import { useVoiceStore } from "../../stores/voiceStore";
import { useTranslation } from "react-i18next";
import VoiceParticipantGrid from "./VoiceParticipantGrid";
import VoiceConnectionStatus from "./VoiceConnectionStatus";
import ScreenShareView from "./ScreenShareView";

function VoiceRoom() {
  const { t } = useTranslation("voice");
  const livekitUrl = useVoiceStore((s) => s.livekitUrl);
  const livekitToken = useVoiceStore((s) => s.livekitToken);

  if (!livekitUrl || !livekitToken) {
    return (
      <div className="voice-room-loading">
        <p>{t("connectingToVoice")}</p>
      </div>
    );
  }

  return (
    <div className="voice-room">
      <VoiceConnectionStatus />
      <ScreenShareView />
      <VoiceParticipantGrid />
    </div>
  );
}

export default VoiceRoom;
