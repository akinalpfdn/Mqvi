/**
 * VoiceParticipantGrid — Ses odasındaki tüm katılımcıların gösterimi.
 *
 * İki mod:
 * 1. Tam mod (screen share yok): flex-1 ile tüm alanı kaplar,
 *    katılımcılar merkeze grid olarak yayılır.
 * 2. Kompakt mod (screen share aktif): shrink-0 ile altta sabit
 *    yükseklikte strip, ekran paylaşımına alan bırakır.
 *
 * Mod algılama: useTracks ile aktif screen share track'lerini kontrol eder.
 * Track varsa kompakt mod, yoksa tam mod.
 *
 * useParticipants nedir?
 * LiveKit React SDK hook'u — odadaki tüm participant'ları (lokal + remote)
 * bir array olarak döner ve katılımcı ekleme/çıkarma olaylarında otomatik günceller.
 */

import { useParticipants, useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useTranslation } from "react-i18next";
import VoiceParticipant from "./VoiceParticipant";

function VoiceParticipantGrid() {
  const { t } = useTranslation("voice");
  const participants = useParticipants();

  // Screen share aktif mi? Layout modunu belirler.
  const screenShareTracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: true }
  );
  const hasScreenShare = screenShareTracks.length > 0;

  if (participants.length === 0) {
    // Screen share aktifken boş mesaj gösterme — alan screen share'e bırakılsın
    if (hasScreenShare) return null;

    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-text-muted">{t("noOneInVoice")}</p>
      </div>
    );
  }

  // Kompakt mod: screen share aktifken altta dar strip
  if (hasScreenShare) {
    return (
      <div className="flex shrink-0 items-center justify-center gap-4 border-t border-background-tertiary px-4 py-3">
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

  // Tam mod: screen share yokken tüm alanı kapla, merkeze yay
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
