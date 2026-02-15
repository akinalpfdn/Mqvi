/**
 * VoiceStateManager — voiceStore ↔ LiveKit senkronizasyonu.
 *
 * Bu component, LiveKitRoom içinde render edilir ve iki yönlü senkronizasyon sağlar:
 *
 * 1. voiceStore → LiveKit:
 *    - isMuted değiştiğinde → localParticipant.setMicrophoneEnabled(!isMuted)
 *    - isStreaming değiştiğinde → localParticipant.setScreenShareEnabled(isStreaming)
 *
 * 2. LiveKit → voiceStore:
 *    - Bağlantı kurulduğunda mikrofon durumunu senkronize eder
 *
 * 3. Push-to-talk:
 *    - inputMode === "push_to_talk" ise usePushToTalk hook'u aktif olur
 *    - PTT tuşuna basılınca mic açılır, bırakılınca kapanır
 *    - PTT, isMuted store state'ini BYPASS eder — doğrudan LiveKit participant
 *      üzerinden çalışır. Bu sayede PTT tuşu bırakıldığında store'daki isMuted
 *      değeri değişmez (UI butonları etkilenmez).
 *
 * 4. Volume senkronizasyonu:
 *    - userVolumes, masterVolume, isDeafened değiştiğinde →
 *      RemoteParticipant.setVolume(effectiveVolume) çağrılır
 *    - webAudioMix: true ile LiveKit kendi GainNode pipeline'ını yönetir
 *    - setVolume(n): 0=mute, 1=normal, >1=amplification (200%'e kadar)
 *
 * Neden ayrı component?
 * - LiveKit hook'ları (useLocalParticipant, useRoomContext) sadece <LiveKitRoom>
 *   içinde çalışır. VoiceRoom.tsx'te LiveKitRoom'u render ederiz,
 *   bu component onun child'ı olarak LiveKit context'ine erişir.
 * - Single Responsibility: VoiceRoom bağlantı kurar, VoiceStateManager state senkronize eder.
 *
 * Görsel çıktısı YOKTUR (null render). Sadece side-effect'ler çalıştırır.
 */

import { useEffect, useRef, useCallback } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { RoomEvent, ConnectionState, Track } from "livekit-client";
import type {
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
} from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { usePushToTalk } from "../../hooks/usePushToTalk";

function VoiceStateManager() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const inputMode = useVoiceStore((s) => s.inputMode);
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const isDeafened = useVoiceStore((s) => s.isDeafened);

  // İlk mount tracking — ilk render'da gereksiz toggle'ları önlemek için.
  // useRef ile tutulur çünkü state değişikliği re-render tetikler ama
  // ref değişikliği tetiklemez — performans kazanımı.
  const initialSyncDone = useRef(false);

  // ─── PTT: Doğrudan LiveKit participant üzerinden mic kontrolü ───
  // usePushToTalk hook'u document-level keydown/keyup dinler.
  // setMicEnabled fonksiyonu PTT tuşuna basılınca/bırakılınca çağrılır.
  //
  // Neden useCallback?
  // usePushToTalk bu fonksiyonu dependency olarak alır. Stable ref olmazsa
  // her render'da effect yeniden kurulur (gereksiz listener add/remove).
  const setMicEnabled = useCallback(
    (enabled: boolean) => {
      localParticipant.setMicrophoneEnabled(enabled).catch((err: unknown) => {
        console.error("[VoiceStateManager] PTT mic toggle failed:", err);
      });
    },
    [localParticipant]
  );

  usePushToTalk({ setMicEnabled });

  // ─── Mikrofon senkronizasyonu ───
  // isMuted değiştiğinde LiveKit'in gerçek mikrofon durumunu güncelle.
  //
  // setMicrophoneEnabled(true) → mikrofonu aç
  // setMicrophoneEnabled(false) → mikrofonu kapat
  //
  // "isMuted" bizim store'daki değer, LiveKit'te "enabled" tersi:
  // isMuted=true → enabled=false, isMuted=false → enabled=true
  //
  // PTT modunda bu effect hâlâ çalışır — kullanıcı VoicePopup'taki mute
  // butonuna tıklarsa store üzerinden mic kapatılır. PTT tuşu ise
  // doğrudan participant'a gider (yukarıdaki setMicEnabled).
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

      // İlk bağlantıda mikrofon durumunu senkronize et.
      // PTT modunda mic kapalı başlar (joinVoiceChannel'da isMuted=true set edildi).
      // Voice activity modunda mic açık başlar (isMuted=false).
      const { isMuted: currentMuted, inputMode: currentMode } = useVoiceStore.getState();

      // PTT modunda LiveKit'in audio={true} ile otomatik açtığı mic'i kapat
      const shouldEnable = currentMode === "push_to_talk" ? false : !currentMuted;

      localParticipant.setMicrophoneEnabled(shouldEnable).catch((err: unknown) => {
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

  // ─── inputMode değiştiğinde mic state güncelle ───
  // Kullanıcı voice settings'ten mod değiştirdiğinde:
  // - PTT'ye geçiş: mic kapat (tuş basılmadıkça kapalı)
  // - Voice activity'ye geçiş: store'daki isMuted'a göre mic aç/kapat
  useEffect(() => {
    if (!initialSyncDone.current) return;

    if (inputMode === "push_to_talk") {
      // PTT moduna geçildi → mic kapat
      localParticipant.setMicrophoneEnabled(false).catch((err: unknown) => {
        console.error("[VoiceStateManager] Failed to mute on PTT switch:", err);
      });
    } else {
      // Voice activity moduna geçildi → store'daki isMuted'a göre ayarla
      const currentMuted = useVoiceStore.getState().isMuted;
      localParticipant.setMicrophoneEnabled(!currentMuted).catch((err: unknown) => {
        console.error("[VoiceStateManager] Failed to restore mic on VA switch:", err);
      });
    }
  }, [inputMode, localParticipant]);

  // ─── Volume senkronizasyonu ───
  // Per-user volume, master volume ve deafen durumunu LiveKit'in
  // RemoteParticipant.setVolume() API'si ile senkronize eder.
  //
  // webAudioMix: true (VoiceRoom'da set edildi) ile LiveKit kendi
  // AudioContext + GainNode pipeline'ını yönetir. setVolume(n):
  //   n=0   → mute
  //   n=1   → normal (%100)
  //   n=2   → amplification (%200)
  //
  // GainNode.gain üst sınırı yok, bu yüzden per-user 200% amplification
  // mümkün. webAudioMix olmadan setVolume HTMLMediaElement.volume kullanır
  // ki 0-1 aralığıyla sınırlıdır ve >1 değerlerde hata fırlatır.

  // volumeRef — TrackSubscribed event handler'ı için latest ref pattern.
  // Effect dependency'si olarak kullanmadan güncel volume state'ine erişim sağlar.
  // Bu sayede TrackSubscribed listener sadece [room] değiştiğinde yeniden kurulur,
  // her volume değişikliğinde değil (gereksiz add/remove listener önlenir).
  const volumeRef = useRef({ userVolumes, masterVolume, isDeafened });
  volumeRef.current = { userVolumes, masterVolume, isDeafened };

  // Mevcut katılımcılara volume uygula — store state değiştiğinde tetiklenir.
  useEffect(() => {
    room.remoteParticipants.forEach((participant) => {
      const userVol = userVolumes[participant.identity] ?? 100;
      const effectiveVolume = isDeafened
        ? 0
        : (userVol / 100) * (masterVolume / 100);
      participant.setVolume(effectiveVolume);
    });
  }, [userVolumes, masterVolume, isDeafened, room]);

  // Yeni participant track subscribe olduğunda volume uygula.
  // Mevcut katılımcılar yukarıdaki effect ile ele alınır, ama yeni
  // katılımcılar room.remoteParticipants'a eklenince effect tetiklenmez
  // (room referansı değişmez). Bu listener yeni track'lere volume atar.
  useEffect(() => {
    function handleTrackSubscribed(
      _track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ): void {
      // Sadece audio track'ler için volume uygula
      if (_track.kind !== Track.Kind.Audio) return;

      const { userVolumes: vols, masterVolume: master, isDeafened: deaf } =
        volumeRef.current;
      const userVol = vols[participant.identity] ?? 100;
      const effectiveVolume = deaf ? 0 : (userVol / 100) * (master / 100);
      participant.setVolume(effectiveVolume);
    }

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);

    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    };
  }, [room]);

  // Görsel çıktısı yok — sadece side-effect'ler
  return null;
}

export default VoiceStateManager;
