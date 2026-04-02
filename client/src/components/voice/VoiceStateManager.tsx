/**
 * VoiceStateManager — Bidirectional voiceStore <-> LiveKit sync.
 * Renders inside LiveKitRoom. No visual output (returns null).
 *
 * Syncs: mic mute, screen share, PTT, per-user volume, noise reduction,
 * speaking detection, screen share subscriptions, and RTT polling.
 */

import { useEffect, useRef, useCallback } from "react";
import { useLocalParticipant, useRoomContext } from "@livekit/components-react";
import { RoomEvent, ParticipantEvent, ConnectionState, Track, LocalAudioTrack as LKLocalAudioTrack } from "livekit-client";
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
import { VadGateProcessor } from "../../audio/VadGateProcessor";
import { useSystemAudioCapture } from "../../hooks/useSystemAudioCapture";
import { isElectron, isCapacitor, resolveUserId } from "../../utils/constants";
import { startNativeScreenShare, stopNativeScreenShare, onNativeScreenShareStopped } from "../../utils/nativePlugins";
import { getScreenShareToken } from "../../api/voice";
import { useServerStore } from "../../stores/serverStore";

/** Both processors expose setMicSensitivity */
type AudioProcessor = RNNoiseProcessor | VadGateProcessor;

function VoiceStateManager() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const inputMode = useVoiceStore((s) => s.inputMode);
  const isServerMuted = useVoiceStore((s) => s.isServerMuted);
  const isServerDeafened = useVoiceStore((s) => s.isServerDeafened);
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const screenShareVolumes = useVoiceStore((s) => s.screenShareVolumes);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);
  const screenShareAudio = useVoiceStore((s) => s.screenShareAudio);
  const noiseReduction = useVoiceStore((s) => s.noiseReduction);
  const micSensitivity = useVoiceStore((s) => s.micSensitivity);

  // Skip effects until initial connection sync is done
  const initialSyncDone = useRef(false);

  // PTT: bypass store, toggle mic directly on LiveKit participant
  const setMicEnabled = useCallback(
    (enabled: boolean) => {
      localParticipant.setMicrophoneEnabled(enabled).catch((err: unknown) => {
        console.error("[VoiceStateManager] PTT mic toggle failed:", err);
      });
    },
    [localParticipant]
  );

  usePushToTalk({ setMicEnabled });

  // Sync isMuted + isServerMuted -> LiveKit mic enabled
  // Server mute overrides local state — mic is always off when server muted
  useEffect(() => {
    if (!initialSyncDone.current) return;

    const shouldEnable = !isMuted && !isServerMuted;
    localParticipant.setMicrophoneEnabled(shouldEnable).catch((err: unknown) => {
      console.error("[VoiceStateManager] Failed to toggle microphone:", err);
    });
  }, [isMuted, isServerMuted, localParticipant]);

  // Process-exclusive audio capture (Electron only).
  // Uses native audio-capture.exe to capture system audio excluding our
  // own Electron process tree — prevents screen share echo.
  const systemAudioCapture = useSystemAudioCapture();
  const systemAudioCaptureRef = useRef(systemAudioCapture);
  systemAudioCaptureRef.current = systemAudioCapture;

  const customAudioPubRef = useRef<LocalTrackPublication | null>(null);

  // Sync isStreaming -> LiveKit screen share.
  // Capacitor (iOS/Android): native plugin via separate LiveKit connection.
  //   iOS: ReplayKit + LiveKit Swift SDK. Android: MediaProjection + LiveKit Android SDK.
  // Electron: video via getDisplayMedia, audio via native WASAPI capture (echo-free).
  // Browser: standard getDisplayMedia with optional audio.
  useEffect(() => {
    if (!initialSyncDone.current) return;

    let cancelled = false;
    const useNativeScreenShare = isCapacitor();

    async function toggleScreenShare() {
      if (cancelled) return;

      if (isStreaming) {
        if (useNativeScreenShare) {
          // Capacitor (iOS/Android): native screen share plugin
          const serverId = useServerStore.getState().activeServerId;
          const channelId = useVoiceStore.getState().currentVoiceChannelId;
          if (!serverId || !channelId) return;

          const response = await getScreenShareToken(serverId, channelId);
          if (cancelled || !response.success || !response.data) {
            console.error("[VoiceStateManager] Failed to get screen share token:", response.error);
            return;
          }

          await startNativeScreenShare(response.data.url, response.data.token);
        } else if (isElectron() && screenShareAudio) {
          // Electron: video only via getDisplayMedia, audio via native capture
          await localParticipant.setScreenShareEnabled(true, {
            audio: false,
            resolution: { width: 1920, height: 1080, frameRate: 30 },
            contentHint: "motion",
          });

          if (cancelled) return;

          const audioTrack = await systemAudioCaptureRef.current.start();

          if (cancelled || !audioTrack) return;

          // Wrap in LiveKit's LocalAudioTrack and publish as ScreenShareAudio
          const lkTrack = new LKLocalAudioTrack(audioTrack, undefined, false);
          const pub = await localParticipant.publishTrack(lkTrack, {
            source: Track.Source.ScreenShareAudio,
          });
          customAudioPubRef.current = pub;
        } else {
          // Browser: standard getDisplayMedia
          await localParticipant.setScreenShareEnabled(true, {
            audio: screenShareAudio,
            resolution: { width: 1920, height: 1080, frameRate: 30 },
            contentHint: "motion",
          });
        }
      } else {
        if (useNativeScreenShare) {
          // Capacitor: stop native screen share
          await stopNativeScreenShare();
        } else {
          if (customAudioPubRef.current) {
            await localParticipant.unpublishTrack(
              customAudioPubRef.current.track!
            );
            customAudioPubRef.current = null;
          }

          systemAudioCaptureRef.current.stop();
          await localParticipant.setScreenShareEnabled(false);
        }
      }
    }

    toggleScreenShare().catch((err: unknown) => {
      if (!cancelled) {
        console.error("[VoiceStateManager] Failed to toggle screen share:", err);
      }
    });

    return () => { cancelled = true; };
  }, [isStreaming, screenShareAudio, localParticipant]);

  // Capacitor: listen for native screen share stopped (user stops externally)
  useEffect(() => {
    if (!isCapacitor()) return;

    let removeListener: (() => void) | null = null;

    onNativeScreenShareStopped(() => {
      // Sync store state — native screen share was stopped externally
      const { isStreaming: currentlyStreaming } = useVoiceStore.getState();
      if (currentlyStreaming) {
        useVoiceStore.getState().setStreaming(false);
      }
    }).then((cleanup) => {
      removeListener = cleanup;
    });

    return () => {
      removeListener?.();
    };
  }, []);

  // Raise EventEmitter limit — we attach many room listeners here + SDK internals
  useEffect(() => {
    if (typeof room.setMaxListeners === "function") {
      room.setMaxListeners(20);
    }
    return () => {
      if (typeof room.setMaxListeners === "function") {
        room.setMaxListeners(10);
      }
    };
  }, [room]);

  // Initial sync on room connect — apply store state to LiveKit
  useEffect(() => {
    function handleConnected() {
      // PTT: mic starts disabled. Voice activity: respect store isMuted + server mute.
      const { isMuted: currentMuted, inputMode: currentMode, isServerMuted: srvMuted } = useVoiceStore.getState();
      const shouldEnable = currentMode === "push_to_talk" ? false : (!currentMuted && !srvMuted);

      localParticipant.setMicrophoneEnabled(shouldEnable).catch((err: unknown) => {
        console.error("[VoiceStateManager] Failed to set initial mic state:", err);
      });

      // Unsubscribe auto-subscribed screen shares — user opts in via sidebar
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

      initialSyncDone.current = true;
    }

    // Restore mic and volumes after SDK internal reconnect.
    // RoomEvent.Reconnected fires when LiveKit reconnects without our intervention.
    function handleReconnected() {
      const { isMuted: currentMuted, inputMode: currentMode, isServerMuted: srvMuted } = useVoiceStore.getState();
      const shouldEnable = currentMode === "push_to_talk" ? false : (!currentMuted && !srvMuted);

      // Wait for PeerConnection to stabilize before re-enabling mic
      setTimeout(() => {
        localParticipant.setMicrophoneEnabled(shouldEnable).catch((err: unknown) => {
          console.error("[VoiceStateManager] Failed to restore mic after reconnect:", err);
        });

        // Re-apply volumes — RemoteParticipant objects may have been recreated
        const { userVolumes: vols, screenShareVolumes: ssVols, masterVolume: master, isDeafened: deaf, isServerDeafened: srvDeaf } =
          useVoiceStore.getState();
        const masterFactor = master / 100;
        const fullyDeaf = deaf || srvDeaf;

        room.remoteParticipants.forEach((participant) => {
          const micVol = vols[participant.identity] ?? 100;
          participant.setVolume(fullyDeaf ? 0 : (micVol / 100) * masterFactor, Track.Source.Microphone);

          const ssVol = ssVols[participant.identity] ?? 100;
          participant.setVolume(fullyDeaf ? 0 : (ssVol / 100) * masterFactor, Track.Source.ScreenShareAudio);
        });
      }, 1000);
    }

    if (room.state === ConnectionState.Connected) {
      handleConnected();
    }

    room.on(RoomEvent.Connected, handleConnected);
    room.on(RoomEvent.Reconnected, handleReconnected);

    return () => {
      room.off(RoomEvent.Connected, handleConnected);
      room.off(RoomEvent.Reconnected, handleReconnected);
      initialSyncDone.current = false;
    };
  }, [room, localParticipant]);

  // RTT polling: try signaling RTT first, fall back to WebRTC stats ICE candidate-pair
  useEffect(() => {
    if (room.state !== ConnectionState.Connected) return;
    let cancelled = false;

    async function pollRtt() {
      if (cancelled) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = (room as any).engine;

        const signalRtt = engine?.client?.rtt as number | undefined;
        if (typeof signalRtt === "number" && signalRtt > 0) {
          useVoiceStore.getState().setRtt(Math.round(signalRtt));
          return;
        }

        const pc = engine?.pcManager?.subscriber?.pc as RTCPeerConnection | undefined;
        if (!pc) return;
        const stats = await pc.getStats();
        if (cancelled) return;

        stats.forEach((report: Record<string, unknown>) => {
          if (
            report.type === "candidate-pair" &&
            report.nominated === true &&
            typeof report.currentRoundTripTime === "number" &&
            report.currentRoundTripTime > 0
          ) {
            useVoiceStore.getState().setRtt(Math.round((report.currentRoundTripTime as number) * 1000));
          }
        });
      } catch {
        // engine/client not ready yet
      }
    }

    pollRtt();
    const interval = setInterval(pollRtt, 3000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [room, room.state]);

  // Speaking detection -> store (for sidebar outside LiveKit context).
  // 300ms hold timer prevents flickering on speech pauses.
  useEffect(() => {
    const HOLD_MS = 150;
    const setActiveSpeakers = useVoiceStore.getState().setActiveSpeakers;

    const heldSpeakers = new Map<string, boolean>();
    const holdTimers = new Map<string, number>();

    function updateStore() {
      const ids: string[] = [];
      heldSpeakers.forEach((speaking, identity) => {
        if (speaking) ids.push(identity);
      });
      setActiveSpeakers(ids);
    }

    function setSpeakerRaw(identity: string, speaking: boolean) {
      if (speaking) {
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
        if (heldSpeakers.get(identity) && !holdTimers.has(identity)) {
          const timerId = window.setTimeout(() => {
            holdTimers.delete(identity);
            heldSpeakers.delete(identity);
            updateStore();
          }, HOLD_MS);
          holdTimers.set(identity, timerId);
        }
      }
    }

    function handleActiveSpeakers(speakers: Participant[]) {
      const activeSpeakerIds = new Set(speakers.map((s) => s.identity));

      for (const s of speakers) {
        if (s.identity !== localParticipant.identity) {
          setSpeakerRaw(s.identity, true);
        }
      }
      heldSpeakers.forEach((_speaking, identity) => {
        if (identity !== localParticipant.identity && !activeSpeakerIds.has(identity)) {
          setSpeakerRaw(identity, false);
        }
      });

      setSpeakerRaw(localParticipant.identity, localParticipant.isSpeaking);
    }

    room.on(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);

    function handleLocalSpeaking(speaking: boolean) {
      setSpeakerRaw(localParticipant.identity, speaking);
    }
    localParticipant.on(ParticipantEvent.IsSpeakingChanged, handleLocalSpeaking);

    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, handleActiveSpeakers);
      localParticipant.off(ParticipantEvent.IsSpeakingChanged, handleLocalSpeaking);
      holdTimers.forEach((timerId) => clearTimeout(timerId));
      holdTimers.clear();
      heldSpeakers.clear();
      setActiveSpeakers([]);
    };
  }, [room, localParticipant]);

  // Sync inputMode changes: PTT -> mic off, voice activity -> restore isMuted
  useEffect(() => {
    if (!initialSyncDone.current) return;

    if (inputMode === "push_to_talk") {
      localParticipant.setMicrophoneEnabled(false).catch((err: unknown) => {
        console.error("[VoiceStateManager] Failed to mute on PTT switch:", err);
      });
    } else {
      const { isMuted: currentMuted, isServerMuted: srvMuted } = useVoiceStore.getState();
      localParticipant.setMicrophoneEnabled(!currentMuted && !srvMuted).catch((err: unknown) => {
        console.error("[VoiceStateManager] Failed to restore mic on VA switch:", err);
      });
    }
  }, [inputMode, localParticipant]);

  // Volume sync: per-user + master + deafen -> RemoteParticipant.setVolume()
  // Requires webAudioMix: true for >100% amplification via GainNode.

  // Latest-ref for volume state — avoids re-registering TrackSubscribed listener on every change
  const volumeRef = useRef({ userVolumes, screenShareVolumes, masterVolume, isDeafened, isServerDeafened });
  volumeRef.current = { userVolumes, screenShareVolumes, masterVolume, isDeafened, isServerDeafened };

  // Server deafen overrides local state — all audio is silenced when server deafened
  const effectiveDeafened = isDeafened || isServerDeafened;

  useEffect(() => {
    room.remoteParticipants.forEach((participant) => {
      const masterFactor = masterVolume / 100;

      const micVol = userVolumes[participant.identity] ?? 100;
      const effectiveMic = effectiveDeafened ? 0 : (micVol / 100) * masterFactor;
      participant.setVolume(effectiveMic, Track.Source.Microphone);

      const ssVol = screenShareVolumes[participant.identity] ?? 100;
      const effectiveSS = effectiveDeafened ? 0 : (ssVol / 100) * masterFactor;
      participant.setVolume(effectiveSS, Track.Source.ScreenShareAudio);
    });
  }, [userVolumes, screenShareVolumes, masterVolume, effectiveDeafened, room]);

  const applyVolumeToParticipant = useCallback(
    (participant: RemoteParticipant) => {
      const {
        userVolumes: vols,
        screenShareVolumes: ssVols,
        masterVolume: master,
        isDeafened: deaf,
        isServerDeafened: srvDeaf,
      } = volumeRef.current;
      const masterFactor = master / 100;
      const fullyDeaf = deaf || srvDeaf;

      const micVol = vols[participant.identity] ?? 100;
      const effectiveMic = fullyDeaf ? 0 : (micVol / 100) * masterFactor;
      participant.setVolume(effectiveMic, Track.Source.Microphone);

      const ssVol = ssVols[participant.identity] ?? 100;
      const effectiveSS = fullyDeaf ? 0 : (ssVol / 100) * masterFactor;
      participant.setVolume(effectiveSS, Track.Source.ScreenShareAudio);
    },
    []
  );

  // Apply volume when new tracks are subscribed.
  // Retry after 300ms — webAudioMix pipeline may not be ready at subscribe time.
  useEffect(() => {
    function handleTrackSubscribed(
      _track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ): void {
      if (_track.kind !== Track.Kind.Audio) return;

      applyVolumeToParticipant(participant);
      setTimeout(() => applyVolumeToParticipant(participant), 300);
    }

    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);

    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    };
  }, [room, applyVolumeToParticipant]);

  // Apply volume on participant reconnect (new RemoteParticipant object)
  useEffect(() => {
    function handleParticipantConnected(participant: RemoteParticipant) {
      setTimeout(() => applyVolumeToParticipant(participant), 500);
    }

    room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);

    return () => {
      room.off(RoomEvent.ParticipantConnected, handleParticipantConnected);
    };
  }, [room, applyVolumeToParticipant]);

  // Audio processor management: NR on -> RNNoise, NR off + sens<100 -> VadGate, else none
  const processorRef = useRef<AudioProcessor | null>(null);
  const noiseReductionRef = useRef(noiseReduction);
  noiseReductionRef.current = noiseReduction;
  const micSensitivityRef = useRef(micSensitivity);
  micSensitivityRef.current = micSensitivity;

  function getDesiredProcessor(nr: boolean, sens: number): "rnnoise" | "vadgate" | "none" {
    if (nr) return "rnnoise";
    if (sens < 100) return "vadgate";
    return "none";
  }

  function getCurrentProcessorType(): "rnnoise" | "vadgate" | "none" {
    if (!processorRef.current) return "none";
    if (processorRef.current instanceof RNNoiseProcessor) return "rnnoise";
    return "vadgate";
  }

  // Switch processor when noiseReduction or micSensitivity changes
  useEffect(() => {
    if (!initialSyncDone.current) return;

    const pub = localParticipant.getTrackPublication(Track.Source.Microphone);
    const audioTrack = pub?.track as LocalAudioTrack | undefined;
    if (!audioTrack) return;

    const desired = getDesiredProcessor(noiseReduction, micSensitivity);
    const current = getCurrentProcessorType();

    if (desired === current) {
      if (processorRef.current && desired !== "none") {
        processorRef.current.setMicSensitivity(micSensitivity);
      }
      return;
    }

    let cancelled = false;

    async function switchProcessor() {
      if (cancelled) return;

      if (processorRef.current) {
        await audioTrack!.stopProcessor();
        processorRef.current = null;
        // Previous processor removed
      }

      if (cancelled) return;

      if (desired === "rnnoise") {
        const processor = new RNNoiseProcessor(micSensitivity);
        processorRef.current = processor;
        await audioTrack!.setProcessor(processor);
        // RNNoise + VAD gate active
      } else if (desired === "vadgate") {
        const processor = new VadGateProcessor(micSensitivity);
        processorRef.current = processor;
        await audioTrack!.setProcessor(processor);
        // VAD gate active
      }
    }

    switchProcessor().catch((err) => {
      if (!cancelled) {
        console.error("[VoiceStateManager] Failed to switch audio processor:", err);
      }
    });

    return () => { cancelled = true; };
  }, [noiseReduction, micSensitivity, localParticipant]);

  // Apply processor when mic track is first published (settings already active on join).
  // The effect above won't catch this since noiseReduction/micSensitivity haven't changed.
  useEffect(() => {
    function handleLocalTrackPublished(pub: LocalTrackPublication) {
      if (pub.source !== Track.Source.Microphone) return;
      if (processorRef.current) return; // already applied

      const desired = getDesiredProcessor(noiseReductionRef.current, micSensitivityRef.current);
      if (desired === "none") return;

      const audioTrack = pub.track as LocalAudioTrack | undefined;
      if (!audioTrack) return;

      let processor: AudioProcessor;
      if (desired === "rnnoise") {
        processor = new RNNoiseProcessor(micSensitivityRef.current);
      } else {
        processor = new VadGateProcessor(micSensitivityRef.current);
      }

      processorRef.current = processor;
      audioTrack.setProcessor(processor)
        .then(() => { /* processor applied */ })
        .catch((err) => console.error("[VoiceStateManager] Failed to apply processor on publish:", err));
    }

    room.on(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
    return () => {
      room.off(RoomEvent.LocalTrackPublished, handleLocalTrackPublished);
    };
  }, [room]);

  // Screen share subscription control.
  // autoSubscribe stays true (audio tracks auto-subscribe).
  // Screen share tracks are manually controlled: unsubscribe on publish,
  // subscribe when user clicks in sidebar.

  // Effect A: Unsubscribe newly published screen share tracks.
  // RoomEvent.TrackPublished fires BEFORE autoSubscribe —
  // setSubscribed(false) cancels the SDK subscribe request.
  useEffect(() => {
    function handleTrackPublished(
      publication: RemoteTrackPublication,
      participant: RemoteParticipant
    ) {
      if (
        publication.source === Track.Source.ScreenShare ||
        publication.source === Track.Source.ScreenShareAudio
      ) {
        const watching = useVoiceStore.getState().watchingScreenShares[resolveUserId(participant.identity)];
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

  // Effect B: Subscribe/unsubscribe when watchingScreenShares changes.
  useEffect(() => {
    room.remoteParticipants.forEach((participant) => {
      const watching = watchingScreenShares[resolveUserId(participant.identity)] ?? false;

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

  return null;
}

export default VoiceStateManager;
