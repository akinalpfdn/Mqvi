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
import { RoomEvent, ConnectionState, Track, LocalAudioTrack as LKLocalAudioTrack } from "livekit-client";
import type {
  LocalAudioTrack,
  LocalTrackPublication,
  Participant,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
} from "livekit-client";
import { useVoiceStore } from "../../stores/voiceStore";
import { usePushToTalk } from "../../hooks/usePushToTalk";
import { RNNoiseProcessor } from "../../audio/RNNoiseProcessor";
import { useSystemAudioCapture } from "../../hooks/useSystemAudioCapture";
import { isElectron } from "../../utils/constants";

function VoiceStateManager() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const inputMode = useVoiceStore((s) => s.inputMode);
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const screenShareVolumes = useVoiceStore((s) => s.screenShareVolumes);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);
  const screenShareAudio = useVoiceStore((s) => s.screenShareAudio);
  const noiseReduction = useVoiceStore((s) => s.noiseReduction);

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

  // ─── Process-exclusive audio capture (Electron only) ───
  // Uses native audio-capture.exe to capture system audio excluding our
  // own Electron process tree — prevents screen share echo.
  const systemAudioCapture = useSystemAudioCapture();
  const systemAudioCaptureRef = useRef(systemAudioCapture);
  systemAudioCaptureRef.current = systemAudioCapture;

  // Ref to track the custom audio publication for cleanup
  const customAudioPubRef = useRef<LocalTrackPublication | null>(null);

  // ─── Screen share senkronizasyonu ───
  // isStreaming değiştiğinde LiveKit'in screen share durumunu güncelle.
  //
  // Electron audio strategy:
  //   - Video: Electron's setDisplayMediaRequestHandler provides the video source
  //   - Audio: NOT from Electron's loopback (causes echo). Instead, our native
  //     audio-capture.exe captures system audio excluding Electron's PID via
  //     WASAPI PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE.
  //   - The custom audio track is published separately to LiveKit as
  //     Track.Source.ScreenShareAudio.
  //
  // Browser audio strategy:
  //   - Uses getDisplayMedia({ audio: true }) — standard browser behavior.
  //   - No process-exclusive capture available in browsers.
  //
  // Capture options:
  //   - resolution: 1920x1080 @ 30fps → tarayıcıdan 1080p yakalama
  //   - contentHint: "motion" → encoder'a motion optimization ipucu verir.
  //     "motion" frame rate'i korur (detail yerine smoothness öncelikli) —
  //     oyun/video paylaşımı için ideal. "detail" ise metin/kod için uygun.
  useEffect(() => {
    if (!initialSyncDone.current) return;

    let cancelled = false;

    async function toggleScreenShare() {
      if (cancelled) return;

      if (isStreaming) {
        // ─── START screen share ───
        if (isElectron() && screenShareAudio) {
          // Electron: video only via getDisplayMedia, audio via native capture
          await localParticipant.setScreenShareEnabled(true, {
            audio: false, // NO loopback audio — we handle audio separately
            resolution: { width: 1920, height: 1080, frameRate: 30 },
            contentHint: "motion",
          });

          if (cancelled) return;

          // Start native process-exclusive audio capture
          const audioTrack = await systemAudioCaptureRef.current.start();

          if (cancelled || !audioTrack) return;

          // Wrap in LiveKit's LocalAudioTrack and publish as ScreenShareAudio
          const lkTrack = new LKLocalAudioTrack(audioTrack, undefined, false);
          const pub = await localParticipant.publishTrack(lkTrack, {
            source: Track.Source.ScreenShareAudio,
          });
          customAudioPubRef.current = pub;
        } else {
          // Browser or no audio: standard getDisplayMedia path
          await localParticipant.setScreenShareEnabled(true, {
            audio: screenShareAudio,
            resolution: { width: 1920, height: 1080, frameRate: 30 },
            contentHint: "motion",
          });
        }
      } else {
        // ─── STOP screen share ───
        // Unpublish custom audio track if we published one
        if (customAudioPubRef.current) {
          await localParticipant.unpublishTrack(
            customAudioPubRef.current.track!
          );
          customAudioPubRef.current = null;
        }

        // Stop native capture
        systemAudioCaptureRef.current.stop();

        // Stop screen share video
        await localParticipant.setScreenShareEnabled(false);
      }
    }

    toggleScreenShare().catch((err: unknown) => {
      if (!cancelled) {
        console.error("[VoiceStateManager] Failed to toggle screen share:", err);
      }
    });

    return () => { cancelled = true; };
  }, [isStreaming, screenShareAudio, localParticipant]);

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

      // ─── Screen share auto-subscribe engelleme ───
      // Room'a bağlandığında zaten auto-subscribe olmuş screen share track'lerini
      // unsubscribe et. Kullanıcı sidebar'dan tıklayınca tekrar subscribe olur.
      // Ses (Microphone) track'leri etkilenmez — sadece ScreenShare/ScreenShareAudio.
      room.remoteParticipants.forEach((p) => {
        p.trackPublications.forEach((pub) => {
          if (
            pub.source === Track.Source.ScreenShare ||
            pub.source === Track.Source.ScreenShareAudio
          ) {
            (pub as RemoteTrackPublication).setSubscribed(false);
          }
        });
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

  // ─── RTT (ping) polling ───
  // LiveKit SignalClient, WebSocket ping/pong ile RTT ölçer.
  // room.engine.client.rtt → millisecond cinsinden round-trip time.
  //
  // İlk ölçüm gecikmesi: LiveKit sunucusu ping interval'ini join response'ta
  // belirler (genellikle ~10sn). İlk pongResp gelene kadar rtt=0 olur.
  // Bu yüzden ilk 15 saniye 1sn aralıkla, sonra 5sn aralıkla poll ederiz.
  //
  // engine ve client @internal olarak işaretli ama public property —
  // LiveKit GitHub #1293'te önerilen yaklaşım budur.
  useEffect(() => {
    if (room.state !== ConnectionState.Connected) return;

    let gotFirstRtt = false;

    function pollRtt() {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rtt = (room as any).engine?.client?.rtt as number | undefined;
        if (typeof rtt === "number" && rtt > 0) {
          useVoiceStore.getState().setRtt(Math.round(rtt));
          gotFirstRtt = true;
        }
      } catch {
        // engine/client henüz hazır değilse sessizce geç
      }
    }

    // İlk değer gelene kadar sık poll et (1sn), sonra yavaşlat (5sn)
    pollRtt();
    const fastInterval = setInterval(() => {
      pollRtt();
      if (gotFirstRtt) {
        clearInterval(fastInterval);
        slowIntervalId = setInterval(pollRtt, 5000);
      }
    }, 1000);

    let slowIntervalId: ReturnType<typeof setInterval> | null = null;

    // 15sn sonra hâlâ hızlı poll devam ediyorsa yavaşlat
    const fallbackTimeout = setTimeout(() => {
      if (!gotFirstRtt) {
        clearInterval(fastInterval);
        slowIntervalId = setInterval(pollRtt, 5000);
      }
    }, 15000);

    return () => {
      clearInterval(fastInterval);
      if (slowIntervalId) clearInterval(slowIntervalId);
      clearTimeout(fallbackTimeout);
    };
  }, [room, room.state]);

  // ─── Speaking detection → store (sidebar için) ───
  //
  // VoiceParticipant (voice room panel): useIsSpeaking hook'u + hold timer kullanır.
  // ChannelTree (sidebar): LiveKit context dışında → store'dan okur.
  //
  // Store güncelleme:
  // - Remote speakers: ActiveSpeakersChanged SFU event'i
  // - Local speaker: localParticipant.isSpeaking polling (150ms interval)
  //
  // Hold timer: Her speaker için 300ms debounce — konuşma bittiğinde hemen
  // store'dan silmek yerine 300ms bekler. Bu sürede tekrar konuşursa timer
  // iptal edilir. VoiceParticipant'taki hold timer ile aynı mantık —
  // sidebar'daki speaking indicator'ın da yanıp sönmesini önler.
  useEffect(() => {
    const HOLD_MS = 300;
    const setActiveSpeakers = useVoiceStore.getState().setActiveSpeakers;

    // Her speaker için: gerçekte konuşuyor mu (raw) + hold timer sonrası durumu (held)
    const heldSpeakers = new Map<string, boolean>(); // identity → held speaking state
    const holdTimers = new Map<string, number>(); // identity → setTimeout id

    function updateStore() {
      const ids: string[] = [];
      heldSpeakers.forEach((speaking, identity) => {
        if (speaking) ids.push(identity);
      });
      setActiveSpeakers(ids);
    }

    /** Bir speaker'ın raw speaking durumunu set et — hold timer ile debounce */
    function setSpeakerRaw(identity: string, speaking: boolean) {
      if (speaking) {
        // Konuşma başladı — bekleyen timer'ı iptal et, hemen göster
        const existing = holdTimers.get(identity);
        if (existing) {
          clearTimeout(existing);
          holdTimers.delete(identity);
        }
        if (!heldSpeakers.get(identity)) {
          heldSpeakers.set(identity, true);
          updateStore();
        }
      } else {
        // Konuşma durdu — hold süresi bekle
        if (heldSpeakers.get(identity) && !holdTimers.has(identity)) {
          const timerId = window.setTimeout(() => {
            holdTimers.delete(identity);
            heldSpeakers.set(identity, false);
            updateStore();
          }, HOLD_MS);
          holdTimers.set(identity, timerId);
        }
      }
    }

    // Remote speakers: SFU event
    function handleActiveSpeakers(speakers: Participant[]) {
      const activeSpeakerIds = new Set(speakers.map((s) => s.identity));

      // Yeni konuşanları işaretle
      for (const s of speakers) {
        if (s.identity !== localParticipant.identity) {
          setSpeakerRaw(s.identity, true);
        }
      }
      // Artık konuşmayan remote'ları işaretle
      heldSpeakers.forEach((_speaking, identity) => {
        if (identity !== localParticipant.identity && !activeSpeakerIds.has(identity)) {
          setSpeakerRaw(identity, false);
        }
      });

      // SFU event geldiğinde local state'i de kontrol et
      setSpeakerRaw(localParticipant.identity, localParticipant.isSpeaking);
    }

    room.on(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);

    // Local speaker: basit polling — participant.isSpeaking property'sini oku
    const pollId = setInterval(() => {
      setSpeakerRaw(localParticipant.identity, localParticipant.isSpeaking);
    }, 150);

    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);
      clearInterval(pollId);
      // Tüm hold timer'ları temizle
      holdTimers.forEach((timerId) => clearTimeout(timerId));
      holdTimers.clear();
      heldSpeakers.clear();
      setActiveSpeakers([]);
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
  const volumeRef = useRef({ userVolumes, screenShareVolumes, masterVolume, isDeafened });
  volumeRef.current = { userVolumes, screenShareVolumes, masterVolume, isDeafened };

  // Mevcut katılımcılara volume uygula — store state değiştiğinde tetiklenir.
  // Dual-source: mic ve screen share audio ayrı ayrı set edilir.
  // LiveKit'in setVolume(vol, source) API'si source parametresiyle
  // hangi track tipine volume uygulanacağını belirler.
  useEffect(() => {
    room.remoteParticipants.forEach((participant) => {
      const masterFactor = masterVolume / 100;

      // Mic volume
      const micVol = userVolumes[participant.identity] ?? 100;
      const effectiveMic = isDeafened ? 0 : (micVol / 100) * masterFactor;
      participant.setVolume(effectiveMic, Track.Source.Microphone);

      // Screen share audio volume — bağımsız kontrol
      const ssVol = screenShareVolumes[participant.identity] ?? 100;
      const effectiveSS = isDeafened ? 0 : (ssVol / 100) * masterFactor;
      participant.setVolume(effectiveSS, Track.Source.ScreenShareAudio);
    });
  }, [userVolumes, screenShareVolumes, masterVolume, isDeafened, room]);

  // ─── Helper: Tek bir participant'a stored volume uygula ───
  // Birden fazla event handler'da kullanıldığı için ayrı fonksiyon.
  // Dual-source: hem mic hem screen share audio volume'u ayrı ayrı set edilir.
  const applyVolumeToParticipant = useCallback(
    (participant: RemoteParticipant) => {
      const {
        userVolumes: vols,
        screenShareVolumes: ssVols,
        masterVolume: master,
        isDeafened: deaf,
      } = volumeRef.current;
      const masterFactor = master / 100;

      // Mic
      const micVol = vols[participant.identity] ?? 100;
      const effectiveMic = deaf ? 0 : (micVol / 100) * masterFactor;
      participant.setVolume(effectiveMic, Track.Source.Microphone);

      // Screen share audio
      const ssVol = ssVols[participant.identity] ?? 100;
      const effectiveSS = deaf ? 0 : (ssVol / 100) * masterFactor;
      participant.setVolume(effectiveSS, Track.Source.ScreenShareAudio);
    },
    []
  );

  // Yeni participant track subscribe olduğunda volume uygula.
  // Mevcut katılımcılar yukarıdaki effect ile ele alınır, ama yeni
  // katılımcılar room.remoteParticipants'a eklenince effect tetiklenmez
  // (room referansı değişmez). Bu listener yeni track'lere volume atar.
  //
  // Ayrıca kısa delay ile retry yapılır — LiveKit webAudioMix pipeline'ı
  // TrackSubscribed anında henüz hazır olmayabilir, setVolume() etkisiz kalır.
  useEffect(() => {
    function handleTrackSubscribed(
      _track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ): void {
      // Sadece audio track'ler için volume uygula
      if (_track.kind !== Track.Kind.Audio) return;

      // Hemen uygula
      applyVolumeToParticipant(participant);

      // WebAudio pipeline hazır olduktan sonra tekrar uygula (race condition fix)
      setTimeout(() => applyVolumeToParticipant(participant), 300);
    }

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);

    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    };
  }, [room, applyVolumeToParticipant]);

  // ─── Participant reconnect'te volume uygula ───
  // Kullanıcı bağlantıyı koparıp yeniden bağlandığında yeni RemoteParticipant
  // nesnesi oluşur. room referansı değişmez → volume effect tetiklenmez.
  // ParticipantConnected event'i yeni katılımcıyı yakalar ve stored volume'u atar.
  useEffect(() => {
    function handleParticipantConnected(participant: RemoteParticipant) {
      // Audio track henüz subscribe olmamış olabilir, ama participant nesnesi
      // hazır. Kısa delay ile WebAudio pipeline'ın kurulmasını bekle.
      setTimeout(() => applyVolumeToParticipant(participant), 500);
    }

    room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);

    return () => {
      room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
    };
  }, [room, applyVolumeToParticipant]);

  // ─── Noise Reduction (RNNoise) senkronizasyonu ───
  // noiseReduction store state'i değiştiğinde processor'ı uygula/kaldır.
  //
  // RNNoiseProcessor LiveKit'in TrackProcessor interface'ini implement eder.
  // setProcessor() çağrılınca LiveKit, mic track'ini processor'ın
  // processedTrack'i ile değiştirir (orijinal yerine denoised track publish edilir).
  //
  // processorRef: Aktif processor instance'ını tutar — tekrar oluşturma ve
  // cleanup için gerekli. noiseReductionRef: Event handler'lardan güncel
  // noiseReduction state'ine erişim (stale closure önlemi).
  const processorRef = useRef<RNNoiseProcessor | null>(null);
  const noiseReductionRef = useRef(noiseReduction);
  noiseReductionRef.current = noiseReduction;

  // noiseReduction toggle edildiğinde processor uygula/kaldır
  useEffect(() => {
    if (!initialSyncDone.current) return;

    const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
    const audioTrack = pub?.track as LocalAudioTrack | undefined;
    if (!audioTrack) return;

    let cancelled = false;

    async function toggle() {
      if (cancelled) return;

      if (noiseReduction) {
        // Processor yoksa oluştur ve uygula
        if (!processorRef.current) {
          const processor = new RNNoiseProcessor();
          processorRef.current = processor;
          await audioTrack!.setProcessor(processor);
          console.log("[VoiceStateManager] RNNoise processor applied");
        }
      } else {
        // Processor varsa kaldır
        if (processorRef.current) {
          await audioTrack!.stopProcessor();
          processorRef.current = null;
          console.log("[VoiceStateManager] RNNoise processor removed");
        }
      }
    }

    toggle().catch((err) => {
      if (!cancelled) {
        console.error("[VoiceStateManager] Failed to toggle noise processor:", err);
      }
    });

    return () => { cancelled = true; };
  }, [noiseReduction, localParticipant]);

  // Mic track publish olduğunda: noiseReduction zaten ON ise processor uygula.
  // Voice'a katılırken noiseReduction açıksa, mic track ilk publish edildiğinde
  // processor otomatik uygulanır. Yukarıdaki toggle effect bu durumu yakalayamaz
  // çünkü noiseReduction değeri değişmemiştir (zaten true'ydu).
  useEffect(() => {
    function handleLocalTrackPublished(pub: LocalTrackPublication) {
      if (pub.source !== Track.Source.Microphone) return;
      if (!noiseReductionRef.current) return;
      if (processorRef.current) return; // Zaten uygulanmış

      const processor = new RNNoiseProcessor();
      processorRef.current = processor;
      const audioTrack = pub.track as LocalAudioTrack | undefined;
      audioTrack?.setProcessor(processor)
        .then(() => console.log("[VoiceStateManager] RNNoise processor applied on track publish"))
        .catch((err) => console.error("[VoiceStateManager] Failed to apply noise processor on publish:", err));
    }

    room.on(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
    return () => {
      room.off(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
    };
  }, [room]);

  // ─── Screen share subscription kontrolü ───
  //
  // autoSubscribe: true kalır (ses track'leri otomatik subscribe olur).
  // Screen share (video + audio) track'leri ise VoiceStateManager tarafından
  // kontrol edilir: publish edildiğinde hemen unsubscribe, kullanıcı
  // sidebar'dan tıklayınca subscribe.
  //
  // Effect A: TrackPublished → yeni screen share track'i auto-subscribe'ı engelle.
  // RoomEvent.TrackPublished, autoSubscribe'dan ÖNCE tetiklenir —
  // setSubscribed(false) çağrılınca SDK subscribe talebini iptal eder.
  useEffect(() => {
    function handleTrackPublished(
      publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) {
      if (
        publication.source === Track.Source.ScreenShare ||
        publication.source === Track.Source.ScreenShareAudio
      ) {
        const watching = useVoiceStore.getState().watchingScreenShares[participant.identity];
        if (!watching) {
          publication.setSubscribed(false);
        }
      }
    }

    room.on(RoomEvent.TrackPublished, handleTrackPublished);
    return () => {
      room.off(RoomEvent.TrackPublished, handleTrackPublished);
    };
  }, [room]);

  // Effect B: watchingScreenShares değiştiğinde subscribe/unsubscribe.
  // Kullanıcı sidebar'daki yayın ikonuna tıkladığında store güncellenir →
  // bu effect tetiklenir → ilgili remote participant'ın screen share track'lerine
  // subscribe (izle) veya unsubscribe (bırak) yapılır.
  //
  // Local participant'ın track'leri burada YOK — room.remoteParticipants
  // sadece remote'ları döndürür. Local yayın preview'i ScreenShareView'de
  // UI filtresi ile kontrol edilir (subscription gerekmez).
  useEffect(() => {
    room.remoteParticipants.forEach((participant) => {
      const watching = watchingScreenShares[participant.identity] ?? false;

      participant.trackPublications.forEach((pub) => {
        if (
          pub.source === Track.Source.ScreenShare ||
          pub.source === Track.Source.ScreenShareAudio
        ) {
          (pub as RemoteTrackPublication).setSubscribed(watching);
        }
      });
    });
  }, [watchingScreenShares, room]);

  // Görsel çıktısı yok — sadece side-effect'ler
  return null;
}

export default VoiceStateManager;
