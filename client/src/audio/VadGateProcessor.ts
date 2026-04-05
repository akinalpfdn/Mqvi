/**
 * VadGateProcessor — Standalone energy-based VAD gate TrackProcessor.
 *
 * Implements LiveKit's TrackProcessor<Track.Kind.Audio>.
 * Used when noise reduction is OFF but micSensitivity slider should still work.
 *
 * - NR ON  -> RNNoiseProcessor (ML denoising + VAD gate included)
 * - NR OFF -> VadGateProcessor (VAD gate only, no denoising)
 *
 * Pipeline: Mic Track -> MediaStreamSource -> VadGateNode -> MediaStreamDestination
 *
 * When micSensitivity is 100 (gate disabled), VoiceStateManager skips
 * applying this processor entirely to avoid unnecessary overhead.
 */

import { Track } from "livekit-client";
import type { TrackProcessor, AudioProcessorOptions } from "livekit-client";

import vadGateWorkletPath from "./vadGateWorklet.js?url";

/** AudioWorklet registration cache — prevents duplicate addModule() calls per AudioContext. */
const registeredContexts = new WeakMap<AudioContext, Promise<void>>();

function ensureWorkletRegistered(ctx: AudioContext): Promise<void> {
  let p = registeredContexts.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(vadGateWorkletPath);
    registeredContexts.set(ctx, p);
  }
  return p;
}

/**
 * Converts micSensitivity (0-100) to RMS threshold (quadratic curve).
 * Same mapping as RNNoiseProcessor for consistent behavior.
 *
 *   100 -> 0     (gate disabled)
 *   50  -> 0.01  (moderate)
 *   0   -> 0.04  (very aggressive)
 */
function sensitivityToThreshold(sensitivity: number): number {
  const clamped = Math.max(0, Math.min(100, sensitivity));
  const inverted = (100 - clamped) / 100;
  return 0.04 * inverted * inverted;
}

class VadGateProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = "vad-gate-standalone";
  processedTrack?: MediaStreamTrack;

  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private vadGateNode: AudioWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  private initialSensitivity: number;
  private initialInputVolume: number;

  constructor(micSensitivity = 50, inputVolume = 100) {
    this.initialSensitivity = micSensitivity;
    this.initialInputVolume = inputVolume;
  }

  /** Builds the audio graph (VAD gate only, no ML denoising — much lighter than RNNoiseProcessor). */
  async init(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    await ensureWorkletRegistered(audioContext);

    const inputStream = new MediaStream([track]);
    this.sourceNode = audioContext.createMediaStreamSource(inputStream);

    // Input volume GainNode — applied before VAD gate processing
    this.gainNode = audioContext.createGain();
    this.gainNode.gain.value = this.initialInputVolume / 100;

    this.vadGateNode = new AudioWorkletNode(audioContext, "vad-gate-processor");
    this.setMicSensitivity(this.initialSensitivity);

    this.destinationNode = audioContext.createMediaStreamDestination();

    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.vadGateNode);
    this.vadGateNode.connect(this.destinationNode);

    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  /** Updates VAD gate threshold. Same API as RNNoiseProcessor for uniform usage. */
  setMicSensitivity(sensitivity: number): void {
    this.initialSensitivity = sensitivity;
    if (this.vadGateNode) {
      const threshold = sensitivityToThreshold(sensitivity);
      this.vadGateNode.port.postMessage({ threshold });
    }
  }

  /** Updates input volume gain. 100 = unity, 200 = 2x amplification. */
  setInputVolume(volume: number): void {
    this.initialInputVolume = volume;
    if (this.gainNode) {
      this.gainNode.gain.value = volume / 100;
    }
  }

  async destroy(): Promise<void> {
    try { this.sourceNode?.disconnect(); } catch { /* already disconnected */ }
    try { this.gainNode?.disconnect(); } catch { /* already disconnected */ }
    try { this.vadGateNode?.disconnect(); } catch { /* already disconnected */ }
    try { this.destinationNode?.disconnect(); } catch { /* already disconnected */ }

    this.sourceNode = null;
    this.gainNode = null;
    this.vadGateNode = null;
    this.destinationNode = null;
    this.processedTrack = undefined;
  }
}

export { VadGateProcessor };
