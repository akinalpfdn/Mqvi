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
 * E2EE: Server her voice room için random passphrase üretir.
 * ExternalE2EEKeyProvider.setKey(passphrase) ile SFrame frame-level encryption aktif.
 * LiveKit'in built-in e2ee-worker'ı kullanılır.
 *
 * CSS: `display:contents` → LiveKitRoom'un div'i layout'ta görünmez,
 * children doğrudan parent'ın flex/grid'ine katılır.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import { DisconnectReason, ExternalE2EEKeyProvider, VideoPreset } from "livekit-client";
import type { AudioCaptureOptions, RoomOptions } from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { useToastStore } from "../../stores/toastStore";
import { useTranslation } from "react-i18next";
import VoiceStateManager from "./VoiceStateManager";

type VoiceProviderProps = {
  children: React.ReactNode;
};

function VoiceProvider({ children }: VoiceProviderProps) {
  const { t } = useTranslation("voice");
  const { t: tE2ee } = useTranslation("e2ee");
  const livekitUrl = useVoiceStore((s) => s.livekitUrl);
  const livekitToken = useVoiceStore((s) => s.livekitToken);
  const e2eePassphrase = useVoiceStore((s) => s.e2eePassphrase);
  const leaveVoiceChannel = useVoiceStore((s) => s.leaveVoiceChannel);
  const inputDevice = useVoiceStore((s) => s.inputDevice);

  /** Voice aktif mi? URL ve token varsa bağlantı kurulur. */
  const isConnected = !!livekitUrl && !!livekitToken;

  // ─── E2EE Key Provider ───

  /**
   * ExternalE2EEKeyProvider — LiveKit SFrame E2EE için key sağlayıcı.
   *
   * Stable instance: useMemo ile tek sefer oluşturulur.
   * setKey(passphrase) ile passphrase set edilir — LiveKit PBKDF2 ile
   * crypto key türetir ve SFrame ile her audio/video frame'i şifreler.
   */
  const keyProvider = useMemo(() => new ExternalE2EEKeyProvider(), []);

  /**
   * e2ee-worker — LiveKit'in built-in SFrame encryption worker'ı.
   *
   * Web Worker olarak çalışır — main thread bloklanmaz.
   * livekit-client package'ından export edilir.
   * Vite import.meta.url ile doğru path resolve edilir.
   *
   * Worker sadece E2EE aktif olduğunda oluşturulur. Passphrase yoksa undefined.
   * Ref ile saklanır — re-render'da yeni Worker oluşturulmaz.
   */
  const workerRef = useRef<Worker | null>(null);

  // E2EE aktifse worker oluştur, değilse terminate et
  useEffect(() => {
    if (e2eePassphrase && !workerRef.current) {
      workerRef.current = new Worker(
        new URL("livekit-client/e2ee-worker", import.meta.url)
      );
    }

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [!!e2eePassphrase]);

  // Passphrase değiştiğinde key set et
  useEffect(() => {
    if (e2eePassphrase) {
      keyProvider.setKey(e2eePassphrase);
    }
  }, [e2eePassphrase, keyProvider]);

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
   * onEncryptionError — SFrame E2EE hatası.
   * Passphrase uyuşmazlığı, worker hatası vb. durumlarda tetiklenir.
   */
  const handleEncryptionError = useCallback(
    (err: Error) => {
      console.error("[VoiceProvider] E2EE encryption error:", err);
      useToastStore.getState().addToast(
        "error",
        tE2ee("voiceE2eeError"),
        8000
      );
    },
    [tE2ee]
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
   * publishDefaults — Screen share encoding + simulcast ayarları.
   *
   * Ana encoding: 1080p/30fps, 3 Mbps — oyun içeriği için yeterli kalite.
   *
   * Simulcast: SFU aynı stream'i birden fazla kalite katmanında tutar.
   * Her alıcıya bant genişliğine göre en uygun katman gönderilir:
   *   - High (1080p/30fps, 3 Mbps): Tam kalite — güçlü bağlantı
   *   - Mid  (720p/30fps, 1.5 Mbps): Orta kalite — normal bağlantı
   *   - Low  (720p/15fps, 800 Kbps): Düşük fps — zayıf bağlantı
   *
   * VP9 codec: Aynı bitrate'te H264'e göre ~30-40% daha iyi sıkıştırma →
   * server bandwidth tasarrufu + daha iyi görüntü kalitesi.
   * Modern GPU'larda (Chrome/Edge) hardware encoding desteği var.
   *
   * useMemo — stable referans: LiveKitRoom prop comparison referans bazlıdır.
   * Yeni obje → gereksiz room reconfiguration. Static config olduğu için
   * dependency boş array — sadece mount'ta oluşturulur.
   */
  const publishDefaults = useMemo(
    () => ({
      screenShareEncoding: {
        maxBitrate: 3_000_000,
        maxFramerate: 30,
      },
      screenShareSimulcastLayers: [
        new VideoPreset(1280, 720, 1_500_000, 30),
        new VideoPreset(1280, 720, 800_000, 15),
      ],
      videoCodec: "vp9" as const,
    }),
    []
  );

  /**
   * roomOptions — LiveKitRoom options.
   *
   * E2EE aktifse (passphrase + worker varsa) e2ee config eklenir.
   * ExternalE2EEKeyProvider.setKey() ile set edilen passphrase'ten
   * LiveKit PBKDF2 ile CryptoKey türetir ve SFrame ile şifreler.
   */
  const roomOptions: RoomOptions | undefined = useMemo(() => {
    if (!isConnected) return undefined;

    const base: RoomOptions = {
      audioCaptureDefaults,
      publishDefaults,
      webAudioMix: true,
    };

    // E2EE: passphrase ve worker varsa SFrame encryption aktif
    if (e2eePassphrase && workerRef.current) {
      base.e2ee = {
        keyProvider,
        worker: workerRef.current,
      };
    }

    return base;
  }, [isConnected, audioCaptureDefaults, publishDefaults, e2eePassphrase, keyProvider]);

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
      options={roomOptions}
      onDisconnected={handleDisconnected}
      onError={handleError}
      onEncryptionError={handleEncryptionError}
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
