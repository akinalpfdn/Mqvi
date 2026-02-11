/**
 * VoiceParticipantGrid — Ses odasındaki tüm katılımcıların grid gösterimi.
 *
 * LiveKit SDK'nın useParticipants hook'u ile aktif katılımcıları alır
 * ve her biri için VoiceParticipant tile'ı render eder.
 *
 * useParticipants nedir?
 * LiveKit React SDK hook'u — odadaki tüm participant'ları (lokal + remote)
 * bir array olarak döner ve katılımcı ekleme/çıkarma olaylarında otomatik günceller.
 */

import { useParticipants } from "@livekit/components-react";
import { useTranslation } from "react-i18next";
import VoiceParticipant from "./VoiceParticipant";

function VoiceParticipantGrid() {
  const { t } = useTranslation("voice");
  const participants = useParticipants();

  if (participants.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-text-muted">{t("noOneInVoice")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-wrap content-center items-center justify-center gap-4 p-6">
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
