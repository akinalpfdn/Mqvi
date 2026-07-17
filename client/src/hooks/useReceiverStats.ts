/**
 * useReceiverStats — live numbers for a screen share, read from the receiving end.
 *
 * The receiver is the honest end: the sharer subscribes to their own share, so these are the
 * frames that came back through the SFU, not what the encoder claims it sent.
 *
 * LiveKit already polls the underlying getStats() for its own monitoring; this reads the parsed
 * result it exposes rather than opening a second stats path.
 */

import { useEffect, useRef, useState } from "react";
import type { RemoteVideoTrack } from "livekit-client";

export type ReceiverSample = {
  fps: number;
  kbps: number;
  width?: number;
  height?: number;
  dropped: number;
  codec?: string;
  decoder?: string;
};

const POLL_MS = 1000;

/** "video/H264" → "H264". Anything unexpected passes through untouched. */
function codecName(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  const slash = mimeType.indexOf("/");
  return slash >= 0 ? mimeType.slice(slash + 1) : mimeType;
}

export function useReceiverStats(track: RemoteVideoTrack | undefined): ReceiverSample | null {
  const [sample, setSample] = useState<ReceiverSample | null>(null);

  // The previous counters are the input to the next reading, not something to render — in state
  // they would double the renders for no one's benefit.
  const prevRef = useRef<{ frames: number; bytes: number; at: number } | null>(null);

  useEffect(() => {
    // getReceiverStats is a receiver-only method: your own share arrives here as a LocalVideoTrack
    // (which has getSenderStats instead), and the callers' `as RemoteVideoTrack` cast hides that
    // from the compiler. Calling it would throw once a second into an unhandled rejection.
    if (!track || typeof track.getReceiverStats !== "function") {
      setSample(null);
      return;
    }

    let cancelled = false;
    prevRef.current = null;

    async function poll() {
      const stats = await track?.getReceiverStats();
      if (cancelled || !stats) return;

      const frames = stats.framesDecoded ?? 0;
      const bytes = stats.bytesReceived ?? 0;
      const at = stats.timestamp;
      const prev = prevRef.current;
      prevRef.current = { frames, bytes, at };

      // Counters are cumulative: a rate needs two readings, so the first one only primes.
      if (!prev || at <= prev.at) return;

      const seconds = (at - prev.at) / 1000;
      setSample({
        fps: Math.max(0, Math.round((frames - prev.frames) / seconds)),
        kbps: Math.max(0, Math.round(((bytes - prev.bytes) * 8) / seconds / 1000)),
        width: stats.frameWidth,
        height: stats.frameHeight,
        dropped: stats.framesDropped ?? 0,
        codec: codecName(stats.mimeType),
        decoder: track?.getDecoderImplementation(),
      });
    }

    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [track]);

  return sample;
}
