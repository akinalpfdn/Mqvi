/**
 * useMicHealthReport — feeds the mic-health tracker from LiveKit and the machine, and sends its
 * reports to the server (see audio/micHealth for what counts as dead and when it is reported).
 *
 * Mounted inside the LiveKit room (VoiceStateManager), so it lives exactly as long as the user is
 * in voice; leaving voice unmounts it, which closes an open episode as "left_voice".
 */

import { useCallback, useEffect, useRef } from "react";
import { App } from "@capacitor/app";
import { ConnectionState, RoomEvent, Track, TrackEvent } from "livekit-client";
import type { LocalAudioTrack, LocalTrackPublication, Participant, Room, TrackPublication } from "livekit-client";
import { MicHealthTracker } from "../audio/micHealth";
import type { MicIntent, MicReport, MicSnapshot, MicTrailEvent } from "../audio/micHealth";
import * as voiceApi from "../api/voice";
import type { MicPlatform, MicProcessorKind } from "../api/voice";
import { useVoiceStore } from "../stores/voiceStore";
import { getCapacitorPlatform, isCapacitor, isElectron } from "../utils/constants";

const TICK_MS = 2_000;

/** What mic-health needs from a processor: our processors expose both (audio/*Processor). */
export type ProbeableProcessor = {
  captureTrack?: MediaStreamTrack;
  audioContext?: BaseAudioContext;
  processedTrack?: MediaStreamTrack;
};

export function currentMicIntent(): MicIntent {
  const { isMuted, isServerMuted, inputMode } = useVoiceStore.getState();
  if (isMuted || isServerMuted) return "off";
  return inputMode === "push_to_talk" ? "ptt" : "live";
}

export type MicProbe = {
  snapshot: MicSnapshot;
  track?: LocalAudioTrack;
  capture?: MediaStreamTrack;
  context?: BaseAudioContext;
};

/**
 * Reads the mic as it is now. The capture track is the raw one: with a processor attached,
 * LiveKit's `mediaStreamTrack` is the processor's output, and the OS mutes and ends the raw track.
 */
export function readMicProbe(
  publication: LocalTrackPublication | undefined,
  connected: boolean,
  intent: MicIntent,
  processor: ProbeableProcessor | null
): MicProbe {
  const track = publication?.track as LocalAudioTrack | undefined;
  const capture = processor?.captureTrack ?? track?.mediaStreamTrack;
  const context = processor?.audioContext;
  return {
    track,
    capture,
    context,
    snapshot: {
      connected,
      intent,
      hasPublication: !!track,
      trackEnded: capture?.readyState === "ended",
      osMuted: capture?.muted === true,
      sdkMuted: track?.isMuted === true,
      upstreamPaused: track?.isUpstreamPaused === true,
      trackDisabled: capture ? !capture.enabled : false,
      contextState: context ? context.state : null,
      processedTrackEnded: processor?.processedTrack?.readyState === "ended",
    },
  };
}

/** The reporting platform, or null where this code is not what carries voice (the iOS app). */
export function micPlatform(): MicPlatform | null {
  if (isElectron()) {
    const p = window.electronAPI?.platform;
    if (p === "darwin") return "electron_mac";
    if (p === "win32") return "electron_windows";
    return "electron_linux";
  }
  if (isCapacitor()) return getCapacitorPlatform() === "android" ? "android" : null;
  return "web";
}

const POWER_EVENTS: ReadonlySet<string> = new Set(["screen_locked", "screen_unlocked", "system_suspend", "system_resume"]);
const CONTEXT_EVENTS: Record<string, MicTrailEvent> = {
  running: "ctx_running",
  suspended: "ctx_suspended",
  closed: "ctx_closed",
  interrupted: "ctx_interrupted",
};

let appVersion: string | null = null;
function resolveAppVersion(): void {
  if (appVersion !== null) return;
  appVersion = typeof __APP_VERSION__ === "string" && !isCapacitor() ? __APP_VERSION__ : "";
  if (isCapacitor()) {
    App.getInfo()
      .then((info) => (appVersion = info.version))
      .catch(() => {}); // reports go without a version
  }
}

/**
 * Returns `noteEvent`, for events only the caller sees (push-to-talk presses).
 */
export function useMicHealthReport(
  room: Room,
  getProcessor: () => ProbeableProcessor | null,
  getProcessorKind: () => MicProcessorKind
): (e: MicTrailEvent) => void {
  const trackerRef = useRef<MicHealthTracker | null>(null);
  const getProcessorRef = useRef(getProcessor);
  getProcessorRef.current = getProcessor;
  const getKindRef = useRef(getProcessorKind);
  getKindRef.current = getProcessorKind;

  useEffect(() => {
    const platform = micPlatform();
    if (!platform) return undefined;
    resolveAppVersion();

    const tracker = new MicHealthTracker();
    trackerRef.current = tracker;
    // Where an episode opened. Its closing report is sent there, after voice state may be gone.
    let episode: { serverId: string; channelId: string; processor: MicProcessorKind } | null = null;

    const send = (report: MicReport) => {
      if (report.event === "dead") {
        const { currentVoiceServerId, currentVoiceChannelId } = useVoiceStore.getState();
        if (!currentVoiceServerId || !currentVoiceChannelId) return;
        episode = { serverId: currentVoiceServerId, channelId: currentVoiceChannelId, processor: getKindRef.current() };
      }
      const target = episode;
      if (report.event !== "dead") episode = null;
      if (!target) return;
      void voiceApi
        .reportMicHealth(target.serverId, {
          ...report,
          channel_id: target.channelId,
          platform,
          processor: target.processor,
          app_version: appVersion ?? "",
        })
        .catch(() => {}); // the call carries on; a lost report is only a lost row
    };

    const note = (e: MicTrailEvent) => tracker.note(e, Date.now());

    // ─── Per-object listeners, rebound when LiveKit replaces the track, capture or context ───
    let bound: { track?: LocalAudioTrack; capture?: MediaStreamTrack; context?: BaseAudioContext } = {};
    let unbind: (() => void)[] = [];

    const rebind = (probe: MicProbe) => {
      if (probe.track === bound.track && probe.capture === bound.capture && probe.context === bound.context) return;
      unbind.forEach((u) => u());
      unbind = [];
      bound = { track: probe.track, capture: probe.capture, context: probe.context };

      const track = probe.track;
      if (track) {
        const onEnded = () => { note("track_ended"); tick(); };
        const onRestarted = () => { note("track_restarted"); tick(); };
        const onPaused = () => { note("upstream_paused"); tick(); };
        const onResumed = () => { note("upstream_resumed"); tick(); };
        track.on(TrackEvent.Ended, onEnded);
        track.on(TrackEvent.Restarted, onRestarted);
        track.on(TrackEvent.UpstreamPaused, onPaused);
        track.on(TrackEvent.UpstreamResumed, onResumed);
        unbind.push(() => {
          track.off(TrackEvent.Ended, onEnded);
          track.off(TrackEvent.Restarted, onRestarted);
          track.off(TrackEvent.UpstreamPaused, onPaused);
          track.off(TrackEvent.UpstreamResumed, onResumed);
        });
      }
      const capture = probe.capture;
      if (capture) {
        const onMute = () => { note("os_muted"); tick(); };
        const onUnmute = () => { note("os_unmuted"); tick(); };
        capture.addEventListener("mute", onMute);
        capture.addEventListener("unmute", onUnmute);
        unbind.push(() => {
          capture.removeEventListener("mute", onMute);
          capture.removeEventListener("unmute", onUnmute);
        });
      }
      const context = probe.context;
      if (context) {
        const onState = () => {
          const e = CONTEXT_EVENTS[context.state];
          if (e) note(e);
          tick();
        };
        context.addEventListener("statechange", onState);
        unbind.push(() => context.removeEventListener("statechange", onState));
      }
    };

    function tick() {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone) as LocalTrackPublication | undefined;
      const probe = readMicProbe(pub, room.state === ConnectionState.Connected, currentMicIntent(), getProcessorRef.current());
      rebind(probe);
      const report = tracker.evaluate(probe.snapshot, Date.now());
      if (report) send(report);
    }

    // ─── Room, store and machine events ───
    const isLocalMic = (pub: TrackPublication, participant?: Participant) =>
      pub.source === Track.Source.Microphone && (participant ? participant.isLocal : true);

    const onReconnecting = () => note("reconnecting");
    const onSignalReconnecting = () => note("signal_reconnecting");
    const onReconnected = () => { note("reconnected"); tick(); };
    const onDisconnected = () => note("disconnected");
    const onPublished = (pub: TrackPublication) => { if (isLocalMic(pub)) { note("mic_published"); tick(); } };
    const onUnpublished = (pub: TrackPublication) => { if (isLocalMic(pub)) { note("mic_unpublished"); tick(); } };
    // A mute the user asked for (or push to talk releasing) is expected; only the SDK's own is evidence.
    const onMuted = (pub: TrackPublication, p: Participant) => { if (isLocalMic(pub, p) && currentMicIntent() === "live") note("sdk_muted"); };
    const onUnmuted = (pub: TrackPublication, p: Participant) => { if (isLocalMic(pub, p) && currentMicIntent() === "live") note("sdk_unmuted"); };
    const onDeviceError = (err: Error, kind?: MediaDeviceKind) => {
      if (kind && kind !== "audioinput") return;
      tracker.noteDeviceError(`${err.name}: ${err.message}`, Date.now());
    };

    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.SignalReconnecting, onSignalReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    room.on(RoomEvent.LocalTrackPublished, onPublished);
    room.on(RoomEvent.LocalTrackUnpublished, onUnpublished);
    room.on(RoomEvent.TrackMuted, onMuted);
    room.on(RoomEvent.TrackUnmuted, onUnmuted);
    room.on(RoomEvent.MediaDevicesError, onDeviceError);

    const unsubStore = useVoiceStore.subscribe((s, prev) => {
      if (s.isMuted !== prev.isMuted) note(s.isMuted ? "user_muted" : "user_unmuted");
    });
    const onVisibility = () => note(document.visibilityState === "hidden" ? "page_hidden" : "page_visible");
    document.addEventListener("visibilitychange", onVisibility);
    const onDeviceChange = () => note("device_change");
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    const unsubPower = window.electronAPI?.onPowerEvent?.((e) => {
      if (POWER_EVENTS.has(e)) note(e as MicTrailEvent);
    });

    const interval = setInterval(tick, TICK_MS);
    tick();

    return () => {
      clearInterval(interval);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.SignalReconnecting, onSignalReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      room.off(RoomEvent.LocalTrackPublished, onPublished);
      room.off(RoomEvent.LocalTrackUnpublished, onUnpublished);
      room.off(RoomEvent.TrackMuted, onMuted);
      room.off(RoomEvent.TrackUnmuted, onUnmuted);
      room.off(RoomEvent.MediaDevicesError, onDeviceError);
      unsubStore();
      document.removeEventListener("visibilitychange", onVisibility);
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      unsubPower?.();
      unbind.forEach((u) => u());
      const closing = tracker.leave(Date.now());
      if (closing) send(closing);
      trackerRef.current = null;
    };
  }, [room]);

  return useCallback((e: MicTrailEvent) => {
    trackerRef.current?.note(e, Date.now());
  }, []);
}
