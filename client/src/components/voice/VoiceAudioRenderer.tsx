/**
 * VoiceAudioRenderer — Remote ses çalma + per-user volume amplification.
 *
 * CSS class'ları: Yok — görsel çıktısı yoktur.
 *
 * İki katmanlı ses mimarisi:
 *
 * Katman 1 — Audio Element (fallback, her zaman çalışır):
 *   track.attach() → <audio> element → hoparlör
 *   - LiveKit'in resmi metodu, autoplay ve codec negotiation'ı yönetir
 *   - Volume kontrolü: audioEl.volume (0-1 aralığı, amplification YOK)
 *   - AudioContext kullanılamadığında bu katman aktif kalır
 *
 * Katman 2 — GainNode Pipeline (amplification destekli):
 *   track.mediaStreamTrack → MediaStream → createMediaStreamSource → GainNode → destination
 *   - GainNode.gain.value üst sınırı yok (0-2.0 = 0-200%)
 *   - AudioContext "running" state'inde aktifleşir
 *   - Aktifken audio element muted olur (çift ses önlenir)
 *
 * Neden iki katman?
 * - createMediaStreamSource: AudioContext "suspended" iken ses VERMEZ
 *   (Chrome autoplay policy — user gesture gerektirir)
 * - track.attach(): Her zaman çalışır (WebRTC audio autoplay'den muaf)
 * - Çözüm: Element hemen ses verir, AudioContext hazır olunca GainNode devralır
 *
 * Neden createMediaElementSource kullanmıyoruz?
 * - Chrome bug: srcObject (MediaStream) ile set edilen <audio> element'lerde
 *   createMediaElementSource audio output'u yakala(ya)mıyor
 * - Ses element'ten direkt çıkıyor, GainNode'a gitmiyor → volume kontrolü çalışmıyor
 * - createMediaStreamSource ile doğrudan MediaStreamTrack'ten okuyoruz → sorun yok
 *
 * AudioContext resume stratejisi:
 * 1. Component mount'ta eager oluştur + hemen resume()
 * 2. Her track attach'inde resume()
 * 3. Fallback: click/keydown listener ile resume
 * 4. statechange event: "running" olunca tüm pipeline'lar GainNode'a geçer
 */

import { useEffect, useRef } from "react";
import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, Track } from "livekit-client";
import type {
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
} from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";

/**
 * AudioPipeline — Tek bir remote audio track'in ses işleme zinciri.
 *
 * track: LiveKit RemoteTrack referansı — detach() cleanup için
 * audioEl: track.attach() ile oluşturulan <audio> element (Katman 1)
 * source: MediaStreamAudioSourceNode — track → AudioContext köprüsü (Katman 2)
 * gain: GainNode — volume kontrolü, null ise GainNode kurulumu başarısız olmuş
 * participantIdentity: voiceStore.userVolumes key'i (user ID)
 * gainActive: true ise GainNode ses veriyor + element muted
 *             false ise element ses veriyor + GainNode pasif
 */
type AudioPipeline = {
  track: RemoteTrack;
  audioEl: HTMLMediaElement;
  source: MediaStreamAudioSourceNode | null;
  gain: GainNode | null;
  participantIdentity: string;
  gainActive: boolean;
};

function VoiceAudioRenderer() {
  const room = useRoomContext();

  /** Paylaşılan AudioContext — tüm GainNode pipeline'ları bu context'te çalışır */
  const audioCtxRef = useRef<AudioContext | null>(null);

  /** Aktif pipeline'lar — key: track SID */
  const pipelinesRef = useRef<Map<string, AudioPipeline>>(new Map());

  // ─── Volume state ───
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const outputDevice = useVoiceStore((s) => s.outputDevice);

  // ─── Effect 1: AudioContext lifecycle ───
  // Eager init + resume + statechange handler.
  // AudioContext "running" olduğunda tüm pipeline'lar GainNode'a geçer.
  useEffect(() => {
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;

    // Hemen resume dene
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    // Fallback: kullanıcı etkileşiminde resume
    function tryResume() {
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
    }

    /**
     * statechange handler — AudioContext "running" olunca TÜM pipeline'ları
     * GainNode moduna geçir.
     *
     * Geçiş sırası:
     * 1. AudioContext "running" → GainNode ses vermeye başlar
     * 2. audioEl.muted = true → element'ten gelen ses kesilir
     * 3. gainActive = true → volume update'ler artık GainNode'u kullanır
     *
     * Adım 1-2 arasında bir anlık overlap olabilir (çift ses) ama
     * aynı event handler içinde olduğu için imperceptible (< 1 frame).
     */
    function handleStateChange() {
      if (ctx.state === "running") {
        pipelinesRef.current.forEach((pipeline) => {
          if (!pipeline.gainActive && pipeline.gain) {
            pipeline.audioEl.muted = true;
            pipeline.gainActive = true;

            // GainNode'a geçerken güncel volume'u uygula
            const {
              userVolumes: vols,
              masterVolume: master,
              isDeafened: deaf,
            } = useVoiceStore.getState();
            const userVol = vols[pipeline.participantIdentity] ?? 100;
            pipeline.gain.gain.value = deaf
              ? 0
              : (userVol / 100) * (master / 100);
          }
        });
      }
    }

    ctx.addEventListener("statechange", handleStateChange);
    // mousedown eklenmeli — volume slider sürüklemesi click değil mousedown event'i.
    // Sağ tık → popup aç → slider sürükle akışında click hiç tetiklenmez,
    // ama mousedown HER etkileşimde tetiklenir ve valid user gesture'dır.
    document.addEventListener("mousedown", tryResume);
    document.addEventListener("click", tryResume);
    document.addEventListener("keydown", tryResume);

    return () => {
      ctx.removeEventListener("statechange", handleStateChange);
      document.removeEventListener("mousedown", tryResume);
      document.removeEventListener("click", tryResume);
      document.removeEventListener("keydown", tryResume);
      ctx.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, []);

  // ─── Effect 2: Track subscription — pipeline oluştur / kaldır ───
  useEffect(() => {
    function attachTrack(
      track: RemoteTrack,
      participant: RemoteParticipant
    ): void {
      if (track.kind !== Track.Kind.Audio) return;
      const sid = track.sid;
      if (!sid || pipelinesRef.current.has(sid)) return;

      // Efektif volume hesapla
      const {
        userVolumes: vols,
        masterVolume: master,
        isDeafened: deaf,
      } = useVoiceStore.getState();
      const userVol = vols[participant.identity] ?? 100;
      const effectiveGain = deaf ? 0 : (userVol / 100) * (master / 100);

      try {
        // ─── Katman 1: Audio element (anında ses) ───
        const audioEl = track.attach();

        // ─── Katman 2: GainNode pipeline (amplification) ───
        const ctx = audioCtxRef.current;
        let source: MediaStreamAudioSourceNode | null = null;
        let gain: GainNode | null = null;
        let gainActive = false;

        if (ctx) {
          // Resume dene — WebRTC audio aktifken Chrome genelde izin verir
          if (ctx.state === "suspended") {
            ctx.resume().catch(() => {});
          }

          try {
            // Track'in raw MediaStreamTrack'inden yeni MediaStream oluştur.
            // createMediaStreamSource bu stream'i AudioContext'e bağlar.
            // Audio element'ten BAĞIMSIZ bir yol — Chrome'un
            // createMediaElementSource bug'ından etkilenmez.
            const mediaStream = new MediaStream([track.mediaStreamTrack]);
            source = ctx.createMediaStreamSource(mediaStream);
            gain = ctx.createGain();

            // AudioContext çalışıyorsa: GainNode aktif, element sessiz
            // AudioContext suspended ise: element aktif, GainNode beklemede
            gainActive = ctx.state === "running";

            if (gainActive) {
              audioEl.muted = true;
              gain.gain.value = effectiveGain;
            } else {
              // GainNode'u önceden ayarla — statechange'de devreye girecek
              gain.gain.value = effectiveGain;
              // Element üzerinden geçici volume (0-1 aralığı, amplification yok)
              audioEl.volume = Math.min(Math.max(effectiveGain, 0), 1);
            }

            source.connect(gain);
            gain.connect(ctx.destination);
          } catch (gainErr) {
            // GainNode kurulumu başarısız — sadece element ile devam et
            console.warn(
              "[VoiceAudioRenderer] GainNode setup failed, element-only mode:",
              gainErr
            );
            audioEl.volume = Math.min(Math.max(effectiveGain, 0), 1);
            source = null;
            gain = null;
          }
        } else {
          // AudioContext yok — sadece element
          audioEl.volume = Math.min(Math.max(effectiveGain, 0), 1);
        }

        pipelinesRef.current.set(sid, {
          track,
          audioEl,
          source,
          gain,
          participantIdentity: participant.identity,
          gainActive,
        });
      } catch (err) {
        console.error("[VoiceAudioRenderer] attachTrack failed:", err);
      }
    }

    function detachTrack(trackSid: string): void {
      const pipeline = pipelinesRef.current.get(trackSid);
      if (!pipeline) return;

      try {
        if (pipeline.source) pipeline.source.disconnect();
        if (pipeline.gain) pipeline.gain.disconnect();
        pipeline.track.detach(pipeline.audioEl);
      } catch {
        // Zaten temizlenmiş
      }
      pipelinesRef.current.delete(trackSid);
    }

    // ─── LiveKit event handler'ları ───
    function handleTrackSubscribed(
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ): void {
      attachTrack(track, participant);
    }

    function handleTrackUnsubscribed(track: RemoteTrack): void {
      if (track.sid) {
        detachTrack(track.sid);
      }
    }

    // Mevcut subscribe olmuş track'leri bağla
    room.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach((pub) => {
        if (pub.isSubscribed && pub.track) {
          attachTrack(pub.track as RemoteTrack, participant);
        }
      });
    });

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);

    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);

      pipelinesRef.current.forEach((pipeline) => {
        try {
          if (pipeline.source) pipeline.source.disconnect();
          if (pipeline.gain) pipeline.gain.disconnect();
          pipeline.track.detach(pipeline.audioEl);
        } catch {
          // Zaten temizlenmiş
        }
      });
      pipelinesRef.current.clear();
    };
  }, [room]);

  // ─── Effect 3: Volume güncelleme ───
  // gainActive moduna göre GainNode VEYA audio element volume'u güncellenir.
  //
  // gainActive=true:  gain.gain.value set (0-2.0 arası, amplification mümkün)
  // gainActive=false: audioEl.volume set (0-1 arası, amplification yok)
  //
  // Ek güvenlik: Her volume update'te AudioContext state kontrol edilir.
  // statechange event'i kaçırılmış olabilir (race condition, suspended→running
  // geçişi Effect 1'deki handler'dan önce tamamlanmış olabilir).
  // Bu check, pipeline'ları GainNode moduna geçirmek için ikinci bir şans verir.
  useEffect(() => {
    const ctx = audioCtxRef.current;
    const masterFactor = masterVolume / 100;

    pipelinesRef.current.forEach((pipeline) => {
      const userVol = userVolumes[pipeline.participantIdentity] ?? 100;
      const effectiveGain = isDeafened
        ? 0
        : (userVol / 100) * masterFactor;

      // Dinamik mod geçişi: AudioContext "running" olduysa ve pipeline hâlâ
      // element modundaysa, GainNode moduna geç. Bu, statechange event'ini
      // kaçırmış pipeline'lar için güvenlik ağıdır.
      if (!pipeline.gainActive && pipeline.gain && ctx?.state === "running") {
        pipeline.audioEl.muted = true;
        pipeline.gainActive = true;
      }

      if (pipeline.gainActive && pipeline.gain) {
        // GainNode aktif — tam aralık (0-2.0)
        pipeline.gain.gain.value = effectiveGain;
      } else {
        // Element aktif — 0-1 aralığı (amplification yok)
        pipeline.audioEl.volume = Math.min(Math.max(effectiveGain, 0), 1);
      }
    });
  }, [userVolumes, masterVolume, isDeafened]);

  // ─── Effect 4: Output device ───
  useEffect(() => {
    if (!audioCtxRef.current || !outputDevice) return;

    const ctx = audioCtxRef.current as AudioContext & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };

    if (typeof ctx.setSinkId === "function") {
      ctx.setSinkId(outputDevice).catch((err: unknown) => {
        console.error("[VoiceAudioRenderer] setSinkId failed:", err);
      });
    }
  }, [outputDevice]);

  return null;
}

export default VoiceAudioRenderer;
