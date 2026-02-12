/**
 * VoiceRoom — LiveKit ses odası wrapper component'i.
 *
 * Layout stratejisi (Discord referans):
 * - Screen share yokken: Katılımcılar flex-1 grid olarak merkeze yayılır
 * - Screen share aktifken: Ekran paylaşımı flex-1 ile alanı kaplar,
 *   katılımcılar altta kompakt strip olarak gösterilir (shrink-0)
 *
 * LiveKitRoom bir <div> render eder — style prop ile flex container yapıyoruz.
 * İçerideki layout wrapper (min-h-0 trick) overflow sorunlarını önler.
 *
 * Component hiyerarşisi:
 * VoiceRoom
 * └── LiveKitRoom (flex-1 flex-col — tüm alanı doldurur)
 *     ├── RoomAudioRenderer (ses çıkışı — görünmez)
 *     ├── VoiceStateManager (store ↔ LiveKit sync — görünmez)
 *     └── Layout wrapper (flex-1 flex-col min-h-0)
 *         ├── VoiceConnectionStatus (null veya small bar)
 *         ├── ScreenShareView (flex-1 — aktifse alanı kaplar)
 *         └── VoiceParticipantGrid (flex-1 veya shrink-0)
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
      // LiveKitRoom bir <div> render eder — flex container yaparak
      // parent ChatArea'nın kalan alanını doldurmasını sağlıyoruz.
      // className yerine style kullanıyoruz çünkü LiveKit'in kendi
      // CSS class'ları ile çakışma olmaz.
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      {/* Ses çıkışı — remote katılımcıların sesini çalar */}
      <RoomAudioRenderer />

      {/* Store ↔ LiveKit senkronizasyonu — mute/deafen/screen share */}
      <VoiceStateManager />

      {/* Layout container — tüm görsel content burada.
          min-h-0: flex child'larda overflow engellemek için gerekli.
          Flex child varsayılan min-height: auto'dur — içerik büyüdüğünde
          parent'ı taşırır. min-h-0 bunu sıfırlar ve overflow: hidden/scroll
          doğru çalışır. */}
      <div className="flex flex-1 flex-col min-h-0">
        <VoiceConnectionStatus />
        <ScreenShareView />
        <VoiceParticipantGrid />
      </div>
    </LiveKitRoom>
  );
}

export default VoiceRoom;
