/**
 * RNNoiseProcessor — RNNoise WASM noise suppression + VAD gate TrackProcessor.
 *
 * Implements LiveKit's TrackProcessor<Track.Kind.Audio>.
 * Uses @sapphi-red/web-noise-suppressor for RNNoise WASM + AudioWorklet
 * to suppress mic noise (breath, keyboard, fan, AC).
 *
 * Audio pipeline:
 *   Mic Track -> MediaStreamSource -> RnnoiseWorkletNode -> VadGateNode -> MediaStreamDestination
 *                                          |                    |
 *                                     RNNoise WASM        Energy-based gate
 *                                 (ML-based denoising)    (controlled by micSensitivity)
 *
 * VAD Gate: measures RMS energy after RNNoise. If below threshold (no speech),
 * outputs silence. Attack (~5ms) and release (~200ms) prevent clipping.
 *
 * micSensitivity (0-100) mapping:
 * - 100 = most sensitive (gate disabled, everything passes)
 * - 50 = moderate (breath cut, speech passes)
 * - 0 = most aggressive (only clear speech passes)
 *
 * Lifecycle: init() -> restart() -> destroy()
 * Used via LocalAudioTrack.setProcessor(new RNNoiseProcessor()).
 */

import { Track } from "livekit-client";
import type { TrackProcessor, AudioProcessorOptions } from "livekit-client";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";

// Vite ?url imports — resolved at build time for AudioWorklet.addModule() and fetch()
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

import vadGateWorkletPath from "./vadGateWorklet.js?url";

/** WASM binary cache — shared across all processor instances (stateless). */
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadRnnoise({
      url: rnnoiseWasmPath,
      simdUrl: rnnoiseSimdWasmPath,
    });
  }
  return wasmBinaryPromise;
}

/**
 * AudioWorklet registration cache per AudioContext.
 * WeakMap so registration is GC'd with the AudioContext.
 */
const registeredContexts = new WeakMap<AudioContext, Map<string, Promise<void>>>();

function ensureWorkletRegistered(ctx: AudioContext, name: string, url: string): Promise<void> {
  let map = registeredContexts.get(ctx);
  if (!map) {
    map = new Map();
    registeredContexts.set(ctx, map);
  }
  let p = map.get(name);
  if (!p) {
    p = ctx.audioWorklet.addModule(url);
    map.set(name, p);
  }
  return p;
}

/**
 * Converts micSensitivity (0-100) to RMS threshold using a quadratic curve.
 *
 *   100 -> 0      (gate disabled)
 *   75  -> 0.0025 (very light gate)
 *   50  -> 0.01   (moderate)
 *   25  -> 0.0225 (aggressive)
 *   0   -> 0.04   (very aggressive)
 *
 * Quadratic because human hearing is logarithmic — low sensitivity needs finer control.
 */
export function sensitivityToThreshold(sensitivity: number): number {
  const clamped = Math.max(0, Math.min(100, sensitivity));
  const inverted = (100 - clamped) / 100;
  return 0.04 * inverted * inverted;
}

class RNNoiseProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = "rnnoise-noise-suppressor";
  processedTrack?: MediaStreamTrack;

  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  private vadGateNode: AudioWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  private initialSensitivity: number;
  private initialInputVolume: number;

  constructor(micSensitivity = 50, inputVolume = 100) {
    this.initialSensitivity = micSensitivity;
    this.initialInputVolume = inputVolume;
  }

  /**
   * Builds the audio processing graph.
   * Called by LiveKit: LocalAudioTrack.setProcessor() -> init().
   *
   * Pipeline: source -> rnnoise -> vadGate -> destination
   */
  async init(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    const wasmBinary = await getWasmBinary();

    await Promise.all([
      ensureWorkletRegistered(audioContext, "rnnoise", rnnoiseWorkletPath),
      ensureWorkletRegistered(audioContext, "vad-gate", vadGateWorkletPath),
    ]);

    const inputStream = new MediaStream([track]);
    this.sourceNode = audioContext.createMediaStreamSource(inputStream);

    // Input volume GainNode — applied before RNNoise processing
    this.gainNode = audioContext.createGain();
    this.gainNode.gain.value = this.initialInputVolume / 100;

    // maxChannels: 1 — mono mic input (stereo unnecessary, saves CPU)
    this.rnnoiseNode = new RnnoiseWorkletNode(audioContext, {
      wasmBinary,
      maxChannels: 1,
    });

    this.vadGateNode = new AudioWorkletNode(audioContext, "vad-gate-processor");
    this.setMicSensitivity(this.initialSensitivity);

    this.destinationNode = audioContext.createMediaStreamDestination();

    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.rnnoiseNode);
    this.rnnoiseNode.connect(this.vadGateNode);
    this.vadGateNode.connect(this.destinationNode);

    // LiveKit publishes this track instead of the original
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  /** Tears down and rebuilds the graph (e.g. on device change). */
  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  /** Updates the VAD gate threshold. Safe to call when processor is inactive. */
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

  /** Disconnects all audio nodes and frees WASM memory. */
  async destroy(): Promise<void> {
    try {
      this.sourceNode?.disconnect();
    } catch {
      /* already disconnected */
    }

    try {
      this.gainNode?.disconnect();
    } catch {
      /* already disconnected */
    }

    try {
      this.rnnoiseNode?.disconnect();
      this.rnnoiseNode?.destroy();
    } catch {
      /* worklet already closed */
    }

    try {
      this.vadGateNode?.disconnect();
    } catch {
      /* already disconnected */
    }

    try {
      this.destinationNode?.disconnect();
    } catch {
      /* already disconnected */
    }

    this.sourceNode = null;
    this.gainNode = null;
    this.rnnoiseNode = null;
    this.vadGateNode = null;
    this.destinationNode = null;
    this.processedTrack = undefined;
  }
}

export { RNNoiseProcessor };
