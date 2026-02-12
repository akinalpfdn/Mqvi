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
 * ├── VoiceStateManager (store ↔ LiveKit sync — görünmez)
 * ├── VoiceConnectionStatus (bağlantı durumu göstergesi)
 * ├── ScreenShareView (aktif ekran paylaşımları — varsa)
 * └── VoiceParticipantGrid (katılımcı grid'i)
 */

import { useCallback } from "react";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import { DisconnectReason } from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { useTranslation } from "react-i18next";
import VoiceParticipantGrid from "./VoiceParticipantGrid";
import VoiceStateManager from "./VoiceStateManager";
import VoiceConnectionStatus from "./VoiceConnectionStatus";
import ScreenShareView from "./ScreenShareView";

function VoiceRoom() {
  const { t } = useTranslation("voice");
  const livekitUrl = useVoiceStore((s) => s.livekitUrl);
  const livekitToken = useVoiceStore((s) => s.livekitToken);
  const leaveVoiceChannel = useVoiceStore((s) => s.leaveVoiceChannel);

  /**
   * onDisconnected — LiveKit bağlantısı koptuğunda çağrılır.
   *
   * DisconnectReason bize NEDEN koptuğunu söyler:
   * - CLIENT_INITIATED: Kullanıcı kendisi ayrıldı (normal)
   * - SERVER_SHUTDOWN: LiveKit sunucusu kapandı
   * - PARTICIPANT_REMOVED: Sunucu tarafından atıldı
   * - ROOM_DELETED: Oda silindi
   * - SIGNAL_DISCONNECTED: Sinyal bağlantısı koptu
   *
   * Beklenmedik kopuşlarda store'u temizliyoruz — kullanıcı UI'da
   * "bağlı" olarak kalmaz.
   */
  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      console.log("[VoiceRoom] Disconnected from LiveKit. Reason:", reason);
      // Store'u temizle — kopuş nedenine bakılmaksızın
      leaveVoiceChannel();
    },
    [leaveVoiceChannel]
  );

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
      onDisconnected={handleDisconnected}
      onError={(err) => {
        console.error("[VoiceRoom] LiveKit error:", err);
      }}
    >
      {/* Ses çıkışı — remote katılımcıların sesini çalar */}
      <RoomAudioRenderer />

      {/* Store ↔ LiveKit senkronizasyonu — mute/deafen/screen share */}
      <VoiceStateManager />

      {/* Bağlantı durumu göstergesi — connecting/reconnecting durumlarını gösterir */}
      <VoiceConnectionStatus />

      {/* Ekran paylaşımı — aktif screen share varsa göster */}
      <ScreenShareView />

      {/* Katılımcı grid'i */}
      <VoiceParticipantGrid />
    </LiveKitRoom>
  );
}

export default VoiceRoom;
