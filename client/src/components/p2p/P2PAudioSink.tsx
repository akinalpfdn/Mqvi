/**
 * P2PAudioSink — app-level remote-audio output for P2P calls.
 *
 * Mounted above the tab/panel tree (in AppLayout) so a call's audio keeps playing when the user
 * switches to another chat tab — which unmounts P2PCallScreen. P2PCallScreen renders only visuals
 * (video + controls); this owns the single audio sink. Mirrors how channel voice keeps
 * RoomAudioRenderer at app level so tab switches don't cut audio.
 */

import { useRef, useEffect, useCallback } from "react";
import { useP2PCallStore } from "../../stores/p2pCallStore";

function P2PAudioSink() {
  const remoteStream = useP2PCallStore((s) => s.remoteStream);
  const remoteVolume = useP2PCallStore((s) => s.remoteVolume);

  const audioRef = useRef<HTMLAudioElement>(null);

  // 0–100% rides the rock-solid <audio>.volume path. Above 100% needs Web Audio amplification
  // (HTMLMediaElement.volume caps at 1.0), engaged only on demand so the default path never
  // touches a flaky AudioContext.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sourceStreamRef = useRef<MediaStream | null>(null);

  const teardownGain = useCallback(() => {
    sourceNodeRef.current?.disconnect();
    gainNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    gainNodeRef.current = null;
    sourceStreamRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx) ctx.close().catch(() => {});
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.srcObject = remoteStream ?? null;
  }, [remoteStream]);

  useEffect(() => {
    const audioEl = audioRef.current;
    if (!audioEl) return;

    if (!remoteStream || remoteVolume <= 100) {
      teardownGain();
      audioEl.muted = false;
      audioEl.volume = remoteStream ? Math.max(0, remoteVolume) / 100 : 1;
      return;
    }

    // remoteVolume > 100 — amplify via Web Audio; the <audio> stays muted so the gain graph is the
    // sole output (no doubled audio). On any Web Audio failure, fall back to the unmuted element at
    // full volume so audio is never lost.
    try {
      let ctx = audioCtxRef.current;
      if (!ctx) {
        ctx = new AudioContext();
        audioCtxRef.current = ctx;
      }
      if (sourceStreamRef.current !== remoteStream) {
        sourceNodeRef.current?.disconnect();
        gainNodeRef.current?.disconnect();
        const source = ctx.createMediaStreamSource(remoteStream);
        const gain = ctx.createGain();
        source.connect(gain).connect(ctx.destination);
        sourceNodeRef.current = source;
        gainNodeRef.current = gain;
        sourceStreamRef.current = remoteStream;
      }
      if (gainNodeRef.current) gainNodeRef.current.gain.value = remoteVolume / 100;
      audioEl.muted = true;
      audioEl.volume = 1;
      void ctx.resume();
    } catch (err) {
      console.error("[p2p] Web Audio amplification failed, falling back:", err);
      teardownGain();
      audioEl.muted = false;
      audioEl.volume = 1;
    }
  }, [remoteStream, remoteVolume, teardownGain]);

  useEffect(() => () => teardownGain(), [teardownGain]);

  return <audio ref={audioRef} autoPlay playsInline />;
}

export default P2PAudioSink;
