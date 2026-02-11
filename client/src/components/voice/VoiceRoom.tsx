/**
 * VoiceRoom — LiveKit ses odası wrapper component'i.
 *
 * LiveKitRoom, LiveKit React SDK'nın ana container component'idir:
 * - serverUrl + token ile LiveKit sunucusuna bağlanır
 * - audio=true: mikrofon erişimi ister
 * - video=false: webcam kullanılmaz (CLAUDE.md: webcam Faz 4'te yok)
 *
 * RoomAudioRenderer nedir?
 * Remote participant'ların ses track'lerini otomatik olarak HTML audio
 * element'lerine bağlar. Bu olmadan diğer katılımcıların sesini duyamazsın.
 * Görsel çıktısı yok, sadece ses pipeline'ını kurar.
 *
 * Component hiyerarşisi:
 * VoiceRoom
 * ├── RoomAudioRenderer (ses çıkışı — görünmez)
 * ├── ScreenShareView (aktif ekran paylaşımları — varsa)
 * └── VoiceParticipantGrid (katılımcı grid'i)
 */

import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import { useVoiceStore } from "../../stores/voiceStore";
import { useTranslation } from "react-i18next";
import VoiceParticipantGrid from "./VoiceParticipantGrid";
import ScreenShareView from "./ScreenShareView";

function VoiceRoom() {
  const { t } = useTranslation("voice");
  const livekitUrl = useVoiceStore((s) => s.livekitUrl);
  const livekitToken = useVoiceStore((s) => s.livekitToken);

  // Token veya URL yoksa bağlanılamaz
  if (!livekitUrl || !livekitToken) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-text-muted">{t("connectingToVoice")}</p>
      </div>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={livekitUrl}
      token={livekitToken}
      connect={true}
      audio={true}
      video={false}
    >
      {/* Ses çıkışı — remote katılımcıların sesini çalar */}
      <RoomAudioRenderer />

      {/* Ekran paylaşımı — aktif screen share varsa göster */}
      <ScreenShareView />

      {/* Katılımcı grid'i */}
      <VoiceParticipantGrid />
    </LiveKitRoom>
  );
}

export default VoiceRoom;
