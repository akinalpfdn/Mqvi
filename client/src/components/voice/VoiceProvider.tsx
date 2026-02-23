/**
 * VoiceProvider — LiveKit bağlantısını AppLayout seviyesinde persistent tutar.
 *
 * SORUN: VoiceRoom PanelView içinde conditional render ediliyordu. Tab değişince
 * unmount → LiveKitRoom unmount → WebRTC bağlantısı kopuyordu.
 *
 * ÇÖZÜM: LiveKitRoom'u AppLayout seviyesinde her zaman mount tut.
 * Visual component'ler (VoiceParticipantGrid, ScreenShareView) tab'da
 * mount/unmount olabilir — LiveKit context parent'ta kalır.
 *
 * LiveKitRoom `display:contents` ile render edilir → CSS layout'u etkilemez.
 * `connect` prop'u false iken Room obje oluşturulur ama bağlanmaz.
 * Voice aktif olunca connect=true → bağlanır. Tab değişince bağlantı korunur.
 *
 * İçerdiği her-zaman-mount component'ler:
 * - RoomAudioRenderer: Remote audio track'leri otomatik attach (ses çalmaya devam)
 * - VoiceStateManager: Store ↔ LiveKit senkronizasyonu (mute/deafen/PTT/volume)
 *
 * CSS: `display:contents` → LiveKitRoom'un div'i layout'ta görünmez,
 * children doğrudan parent'ın flex/grid'ine katılır.
 */

import { useCallback, useMemo } from "react";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import { DisconnectReason } from "livekit-client";
import type { AudioCaptureOptions } from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { useToastStore } from "../../stores/toastStore";
import { useTranslation } from "react-i18next";
import VoiceStateManager from "./VoiceStateManager";

type VoiceProviderProps = {
  children: React.ReactNode;
};

function VoiceProvider({ children }: VoiceProviderProps) {
  const { t } = useTranslation("voice");
  const livekitUrl = useVoiceStore((s) => s.livekitUrl);
  const livekitToken = useVoiceStore((s) => s.livekitToken);
  const leaveVoiceChannel = useVoiceStore((s) => s.leaveVoiceChannel);
  const inputDevice = useVoiceStore((s) => s.inputDevice);

  /** Voice aktif mi? URL ve token varsa bağlantı kurulur. */
  const isConnected = !!livekitUrl && !!livekitToken;

  /**
   * onDisconnected — LiveKit bağlantısı koptuğunda çağrılır.
   *
   * DisconnectReason bize NEDEN koptuğunu söyler:
   * - CLIENT_INITIATED: Kullanıcı kendisi ayrıldı veya connect prop geçişi
   * - SERVER_SHUTDOWN: LiveKit sunucusu kapandı
   * - PARTICIPANT_REMOVED: Sunucu tarafından atıldı
   * - ROOM_DELETED: Oda silindi
   * - SIGNAL_DISCONNECTED: Sinyal bağlantısı koptu
   *
   * ÖNEMLİ — CLIENT_INITIATED geçiş disconnect'leri:
   * LiveKitRoom connect={false} → connect={true} geçişinde eski state'i
   * temizlerken CLIENT_INITIATED disconnect event'i fırlatır. Bu bir hata
   * değil — Room'un normal geçiş davranışıdır.
   *
   * Bunu gerçek disconnect'ten ayırmak için: currentVoiceChannelId kontrol edilir.
   * Kullanıcı gerçekten disconnect tıklarsa, useVoice.leaveVoice() önce
   * store'u temizler (currentVoiceChannelId=null), SONRA LiveKit disconnect
   * event'i gelir. Geçiş disconnect'inde ise store hâlâ aktif durumdadır.
   */
  const handleDisconnected = useCallback(
    (reason?: DisconnectReason) => {
      console.log("[VoiceProvider] Disconnected from LiveKit. Reason:", reason);

      // CLIENT_INITIATED: Kullanıcı disconnect tıkladıysa store zaten temiz.
      // Store hâlâ aktifse bu bir connect geçiş disconnect'idir — yoksay.
      if (reason === DisconnectReason.CLIENT_INITIATED) {
        const { currentVoiceChannelId } = useVoiceStore.getState();
        if (currentVoiceChannelId) {
          console.log("[VoiceProvider] Transition disconnect, ignoring (voice still active)");
          return;
        }
      }

      leaveVoiceChannel();
    },
    [leaveVoiceChannel]
  );

  /**
   * onError — LiveKit bağlantı/çalışma zamanı hatası.
   *
   * "Client initiated" hataları connect geçişinde normal olarak fırlatılır
   * (connect={false} → connect={true}). Bunlar filtrelenir — kullanıcıya
   * gereksiz hata toast'u gösterilmez.
   */
  const handleError = useCallback(
    (err: Error) => {
      // connect={false} → connect={true} geçişinde LiveKit "Client initiated"
      // ConnectionError fırlatır. Bu beklenen davranıştır, hata değil.
      if (err.message?.includes("Client initiated")) {
        console.log("[VoiceProvider] Ignoring transition error:", err.message);
        return;
      }

      console.error("[VoiceProvider] LiveKit error:", err);
      useToastStore.getState().addToast(
        "error",
        t("livekitConnectionError"),
        8000
      );
    },
    [t]
  );

  /**
   * audioCaptureDefaults — LiveKit'e mikrofon yakalama ayarlarını iletir.
   *
   * useMemo ile sarılır — re-render'da gereksiz yeni obje oluşmasını önler.
   * LiveKitRoom prop comparison referans bazlıdır, yeni obje → yeniden
   * bağlantı tetikleyebilir.
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

  /**
   * LiveKitRoom her zaman render edilir:
   * - connect={false} → Room obje oluşturulur ama bağlanmaz
   * - connect={true}  → Bağlanır, audio/video pipeline aktif
   *
   * Bu sayede children (SplitPaneContainer vb.) hiçbir zaman remount olmaz.
   * Voice başladığında/bittiğinde sadece connect prop değişir.
   *
   * display:contents → LiveKitRoom'un wrapper div'i CSS layout'ta görünmez.
   * Children doğrudan parent'ın flex container'ına katılır.
   */
  return (
    <LiveKitRoom
      serverUrl={livekitUrl || "wss://placeholder.invalid"}
      token={livekitToken || ""}
      connect={isConnected}
      audio={isConnected}
      video={false}
      options={isConnected ? { audioCaptureDefaults, webAudioMix: true } : undefined}
      onDisconnected={handleDisconnected}
      onError={handleError}
      style={{ display: "contents" }}
    >
      {/* Audio rendering + state sync — sadece voice aktifken */}
      {isConnected && <RoomAudioRenderer />}
      {isConnected && <VoiceStateManager />}
      {children}
    </LiveKitRoom>
  );
}

export default VoiceProvider;
