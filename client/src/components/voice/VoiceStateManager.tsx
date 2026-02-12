/**
 * VoiceStateManager — voiceStore ↔ LiveKit senkronizasyonu.
 *
 * Bu component, LiveKitRoom içinde render edilir ve iki yönlü senkronizasyon sağlar:
 *
 * 1. voiceStore → LiveKit:
 *    - isMuted değiştiğinde → localParticipant.setMicrophoneEnabled(!isMuted)
 *    - isDeafened değiştiğinde → remote audio element'lerinin volume'unu kontrol eder
 *    - isStreaming değiştiğinde → localParticipant.setScreenShareEnabled(isStreaming)
 *
 * 2. LiveKit → voiceStore:
 *    - Bağlantı kurulduğunda mikrofon durumunu senkronize eder
 *
 * Neden ayrı component?
 * - LiveKit hook'ları (useLocalParticipant, useRoomContext) sadece <LiveKitRoom>
 *   içinde çalışır. VoiceRoom.tsx'te LiveKitRoom'u render ederiz,
 *   bu component onun child'ı olarak LiveKit context'ine erişir.
 * - Single Responsibility: VoiceRoom bağlantı kurar, VoiceStateManager state senkronize eder.
 *
 * Görsel çıktısı YOKTUR (null render). Sadece side-effect'ler çalıştırır.
 */

import { useEffect, useRef } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { RoomEvent, ConnectionState } from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";

function VoiceStateManager() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isStreaming = useVoiceStore((s) => s.isStreaming);

  // İlk mount tracking — ilk render'da gereksiz toggle'ları önlemek için.
  // useRef ile tutulur çünkü state değişikliği re-render tetikler ama
  // ref değişikliği tetiklemez — performans kazanımı.
  const initialSyncDone = useRef(false);

  // ─── Mikrofon senkronizasyonu ───
  // isMuted değiştiğinde LiveKit'in gerçek mikrofon durumunu güncelle.
  //
  // setMicrophoneEnabled(true) → mikrofonu aç
  // setMicrophoneEnabled(false) → mikrofonu kapat
  //
  // "isMuted" bizim store'daki değer, LiveKit'te "enabled" tersi:
  // isMuted=true → enabled=false, isMuted=false → enabled=true
  useEffect(() => {
    if (!initialSyncDone.current) return;

    localParticipant.setMicrophoneEnabled(!isMuted).catch((err: unknown) => {
      console.error("[VoiceStateManager] Failed to toggle microphone:", err);
    });
  }, [isMuted, localParticipant]);

  // ─── Screen share senkronizasyonu ───
  // isStreaming değiştiğinde LiveKit'in screen share durumunu güncelle.
  useEffect(() => {
    if (!initialSyncDone.current) return;

    localParticipant.setScreenShareEnabled(isStreaming).catch((err: unknown) => {
      console.error("[VoiceStateManager] Failed to toggle screen share:", err);
    });
  }, [isStreaming, localParticipant]);

  // ─── Bağlantı kurulduğunda ilk senkronizasyon ───
  // Room'a bağlandığımızda store'daki state'i LiveKit'e uygula.
  //
  // RoomEvent.Connected: LiveKit sunucusuna başarıyla bağlanıldığında tetiklenir.
  // Bu noktada localParticipant hazır ve track'ler yönetilebilir.
  useEffect(() => {
    function handleConnected() {
      console.log("[VoiceStateManager] Connected to LiveKit room");

      // İlk bağlantıda mikrofon durumunu senkronize et
      // joinVoiceChannel'da isMuted=false set ediliyor, yani mikrofon açık olmalı.
      // audio={true} ile LiveKit zaten mikrofonu açar, ama emin olmak için:
      const currentMuted = useVoiceStore.getState().isMuted;
      localParticipant.setMicrophoneEnabled(!currentMuted).catch((err: unknown) => {
        console.error("[VoiceStateManager] Failed to set initial mic state:", err);
      });

      // İlk sync tamamlandı, artık effect'ler çalışabilir
      initialSyncDone.current = true;
    }

    // Room zaten bağlıysa hemen sync yap
    if (room.state === ConnectionState.Connected) {
      handleConnected();
    }

    room.on(RoomEvent.Connected, handleConnected);

    return () => {
      room.off(RoomEvent.Connected, handleConnected);
      initialSyncDone.current = false;
    };
  }, [room, localParticipant]);

  // ─── Deafen: Remote ses kontrolü ───
  // Deafen edildiğinde tüm remote audio element'lerinin volume'unu 0 yap.
  // LiveKit SDK'da doğrudan "deafen" özelliği yok — remote participant'ların
  // audio track'lerini volume=0 yaparak simüle ediyoruz.
  useEffect(() => {
    if (!initialSyncDone.current) return;

    // Remote participant'ların audio track'lerini bul
    room.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach((pub) => {
        if (pub.track) {
          // TrackPublication.setEnabled: false → track subscribe'ı durdurur
          // Bu, ses tamamen kesilir (bandwidth da azalır)
          pub.setEnabled(!isDeafened);
        }
      });
    });

    console.log("[VoiceStateManager] Deafen state changed:", isDeafened);
  }, [isDeafened, room]);

  // Görsel çıktısı yok — sadece side-effect'ler
  return null;
}

export default VoiceStateManager;
