/**
 * VoiceRoom — LiveKit ses odası wrapper component'i.
 *
 * CSS class'ları: .voice-room, .voice-room-loading
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
 * └── LiveKitRoom (flex-1 flex-col — tüm alanı doldurur, webAudioMix: true)
 *     ├── RoomAudioRenderer (LiveKit resmi — remote audio attach, görünmez)
 *     ├── VoiceStateManager (store ↔ LiveKit sync + volume — görünmez)
 *     └── Layout wrapper (voice-room)
 *         ├── VoiceConnectionStatus (null veya small bar)
 *         ├── ScreenShareView (flex-1 — aktifse alanı kaplar)
 *         └── VoiceParticipantGrid (flex-1 veya shrink-0)
 */

import { useCallback, useMemo } from "react";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import { DisconnectReason } from "livekit-client";
import type { AudioCaptureOptions } from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { useToastStore } from "../../stores/toastStore";
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
  const inputDevice = useVoiceStore((s) => s.inputDevice);

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

  /**
   * audioCaptureDefaults — LiveKit'e mikrofon yakalama ayarlarını iletir.
   *
   * WebRTC MediaTrackConstraints üzerine inşa edilmiştir:
   * - noiseSuppression: Arka plan gürültüsünü azaltır (fan, klima vb.)
   * - autoGainControl: Ses seviyesini otomatik normalize eder (fısıltı↔bağırma)
   * - echoCancellation: Hoparlörden gelen sesin mikrofona geri dönmesini önler
   * - deviceId: Seçili mikrofon cihazı (boşsa sistem varsayılanı)
   *
   * useMemo ile sarılır — VoiceRoom re-render olduğunda gereksiz yeni obje
   * oluşmasını önler. LiveKitRoom prop comparison'ı referans bazlıdır,
   * yeni obje → yeniden bağlantı tetikleyebilir.
   */
  const audioCaptureDefaults: AudioCaptureOptions = useMemo(
    () => ({
      noiseSuppression: true,
      autoGainControl: true,
      echoCancellation: true,
      ...(inputDevice ? { deviceId: inputDevice } : {}),
    }),
    [inputDevice]
  );

  // Token veya URL yoksa bağlanılamaz
  if (!livekitUrl || !livekitToken) {
    return (
      <div className="voice-room-loading">
        <p>{t("connectingToVoice")}</p>
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
      options={{
        audioCaptureDefaults,
        // webAudioMix: true → LiveKit kendi AudioContext + GainNode pipeline'ını
        // oluşturur. Bu sayede RemoteParticipant.setVolume(n) ile n > 1 değerleri
        // amplification yapar (GainNode.gain sınırsız). Onsuz setVolume
        // HTMLMediaElement.volume kullanır ki 0-1 aralığıyla sınırlıdır.
        webAudioMix: true,
      }}
      onDisconnected={handleDisconnected}
      onError={(err) => {
        console.error("[VoiceRoom] LiveKit error:", err);
        /**
         * Kullanıcıya toast ile hata bildir.
         * LiveKit bağlantı hataları genellikle:
         * - Sunucu erişilemiyor (ECONNREFUSED, timeout)
         * - Token geçersiz / süresi dolmuş
         * - Room bulunamadı
         */
        useToastStore.getState().addToast(
          "error",
          t("livekitConnectionError"),
          8000
        );
      }}
      // LiveKitRoom bir <div> render eder — flex container yaparak
      // parent ChatArea'nın kalan alanını doldurmasını sağlıyoruz.
      // className yerine style kullanıyoruz çünkü LiveKit'in kendi
      // CSS class'ları ile çakışma olmaz.
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      {/* LiveKit'in resmi audio renderer'ı — remote audio track'leri otomatik attach eder.
          webAudioMix: true ile ses AudioContext GainNode üzerinden geçer,
          RemoteParticipant.setVolume() ile 0-200% amplification mümkün olur. */}
      <RoomAudioRenderer />

      {/* Store ↔ LiveKit senkronizasyonu — mute/deafen/screen share */}
      <VoiceStateManager />

      {/* Layout container — tüm görsel content burada.
          voice-room class'ı: flex:1, flex-col, min-height:0.
          min-h-0: flex child'larda overflow engellemek için gerekli.
          Flex child varsayılan min-height: auto'dur — içerik büyüdüğünde
          parent'ı taşırır. min-h-0 bunu sıfırlar ve overflow: hidden/scroll
          doğru çalışır. */}
      <div className="voice-room">
        <VoiceConnectionStatus />
        <ScreenShareView />
        <VoiceParticipantGrid />
      </div>
    </LiveKitRoom>
  );
}

export default VoiceRoom;
