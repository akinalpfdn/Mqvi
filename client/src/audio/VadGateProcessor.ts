/**
 * VadGateProcessor — Standalone enerji tabanlı VAD gate TrackProcessor'ı.
 *
 * LiveKit'in TrackProcessor<Track.Kind.Audio> interface'ini implement eder.
 * RNNoise KAPALI iken micSensitivity slider'ın çalışması için kullanılır.
 *
 * Discord'daki gibi mic sensitivity noise reduction'dan bağımsız çalışır:
 * - NR ON  → RNNoiseProcessor (ML denoising + VAD gate dahil)
 * - NR OFF → VadGateProcessor (sadece VAD gate, denoising yok)
 *
 * Audio akışı:
 *   Mic Track → MediaStreamSource → VadGateNode → MediaStreamDestination
 *                                       ↑
 *                                  Energy-based gate
 *                               (micSensitivity ile kontrol)
 *
 * micSensitivity 100 = gate devre dışı (her şey geçer) → bu durumda
 * VoiceStateManager processor'ı hiç uygulamaz (gereksiz pipeline overhead'i önlenir).
 */

import { Track } from "livekit-client";
import type { TrackProcessor, AudioProcessorOptions } from "livekit-client";

// VAD gate worklet — enerji tabanlı ses kapısı (RNNoiseProcessor ile aynı worklet)
import vadGateWorkletPath from "./vadGateWorklet.js?url";

/**
 * AudioWorklet registration cache — aynı AudioContext'e birden fazla
 * addModule() çağrısı yapılmasını önler. WeakMap kullanılır çünkü
 * AudioContext garbage collect olursa registration da temizlensin.
 */
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
 * sensitivityToThreshold — micSensitivity (0-100) değerini RMS threshold'a çevirir.
 * RNNoiseProcessor'daki ile aynı mapping — tutarlı davranış için.
 *
 * Quadratic curve:
 *   sensitivity 100 → threshold 0     (gate devre dışı)
 *   sensitivity 50  → threshold 0.01   (moderate)
 *   sensitivity 0   → threshold 0.04   (çok agresif)
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
  private vadGateNode: AudioWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  private initialSensitivity: number;

  constructor(micSensitivity = 50) {
    this.initialSensitivity = micSensitivity;
  }

  /**
   * init — Audio processing graph'ı kurar (sadece VAD gate, ML denoising yok).
   *
   * Pipeline: source → vadGate → destination
   * RNNoiseProcessor'a göre çok daha hafif — WASM yüklemesi yok.
   */
  async init(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    // AudioWorklet register et
    await ensureWorkletRegistered(audioContext);

    // Input: mic track → source node
    const inputStream = new MediaStream([track]);
    this.sourceNode = audioContext.createMediaStreamSource(inputStream);

    // VAD gate node
    this.vadGateNode = new AudioWorkletNode(audioContext, "vad-gate-processor");
    this.setMicSensitivity(this.initialSensitivity);

    // Output: destination node
    this.destinationNode = audioContext.createMediaStreamDestination();

    // Graph bağla: source → vadGate → destination
    this.sourceNode.connect(this.vadGateNode);
    this.vadGateNode.connect(this.destinationNode);

    // LiveKit bu track'i publish eder
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  /**
   * setMicSensitivity — VAD gate threshold'unu günceller.
   * RNNoiseProcessor ile aynı API — VoiceStateManager her ikisini de
   * aynı şekilde kullanabilir.
   */
  setMicSensitivity(sensitivity: number): void {
    this.initialSensitivity = sensitivity;
    if (this.vadGateNode) {
      const threshold = sensitivityToThreshold(sensitivity);
      this.vadGateNode.port.postMessage({ threshold });
    }
  }

  async destroy(): Promise<void> {
    try { this.sourceNode?.disconnect(); } catch { /* already disconnected */ }
    try { this.vadGateNode?.disconnect(); } catch { /* already disconnected */ }
    try { this.destinationNode?.disconnect(); } catch { /* already disconnected */ }

    this.sourceNode = null;
    this.vadGateNode = null;
    this.destinationNode = null;
    this.processedTrack = undefined;
  }
}

export { VadGateProcessor };
