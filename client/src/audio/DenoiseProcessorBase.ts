/**
 * DenoiseProcessorBase — the audio graph both denoisers share.
 *
 * RNNoise and GTCRN differ in four things: which wasm to load, which worklet module to register,
 * which node class to construct, and what the processor is called. Everything else — the source,
 * the input-volume gain, the VAD gate, the destination, and the teardown order — is identical, and
 * duplicating it is how the two engines drift apart.
 *
 * Pipeline: Mic Track -> MediaStreamSource -> Gain -> <engine> -> VadGate -> MediaStreamDestination
 *
 * Subclasses stay separate classes on purpose: VoiceStateManager identifies the live processor with
 * `instanceof`, so collapsing them into one parameterised class would make the running engine
 * indistinguishable.
 */

import { Track } from "livekit-client";
import type { TrackProcessor, AudioProcessorOptions } from "livekit-client";

import vadGateWorkletPath from "./vadGateWorklet.js?url";
import { sensitivityToThreshold } from "./micSensitivity";

/** What both engine nodes offer: an AudioWorkletNode that owns wasm memory it must release. */
export type DenoiseEngineNode = AudioWorkletNode & { destroy(): void };

/**
 * AudioWorklet registration cache per AudioContext, keyed by module name.
 * WeakMap so registrations are collected with the context.
 */
const registeredContexts = new WeakMap<AudioContext, Map<string, Promise<void>>>();

export function ensureWorkletRegistered(
  ctx: AudioContext,
  name: string,
  url: string
): Promise<void> {
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

export abstract class DenoiseProcessorBase
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  abstract name: string;
  processedTrack?: MediaStreamTrack;

  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private engineNode: DenoiseEngineNode | null = null;
  private vadGateNode: AudioWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  private initialSensitivity: number;
  private initialInputVolume: number;

  constructor(micSensitivity = 50, inputVolume = 100) {
    this.initialSensitivity = micSensitivity;
    this.initialInputVolume = inputVolume;
  }

  /** Registers the engine's worklet module and fetches its wasm. Called before `createEngineNode`. */
  protected abstract prepareEngine(ctx: AudioContext): Promise<ArrayBuffer>;

  /** Builds the engine node. Mono on purpose — a mic is one channel and stereo just costs CPU. */
  protected abstract createEngineNode(ctx: AudioContext, wasmBinary: ArrayBuffer): DenoiseEngineNode;

  /** Called by LiveKit through `LocalAudioTrack.setProcessor()`. */
  async init(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    const [wasmBinary] = await Promise.all([
      this.prepareEngine(audioContext),
      ensureWorkletRegistered(audioContext, "vad-gate", vadGateWorkletPath),
    ]);

    this.sourceNode = audioContext.createMediaStreamSource(new MediaStream([track]));

    // Input volume is applied before denoising: the engine should see the level the user chose.
    this.gainNode = audioContext.createGain();
    this.gainNode.gain.value = this.initialInputVolume / 100;
    this.gainNode.channelCount = 1;
    this.gainNode.channelCountMode = "explicit";
    this.gainNode.channelInterpretation = "speakers";

    this.engineNode = this.createEngineNode(audioContext, wasmBinary);

    this.vadGateNode = new AudioWorkletNode(audioContext, "vad-gate-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    this.setMicSensitivity(this.initialSensitivity);

    this.destinationNode = audioContext.createMediaStreamDestination();
    this.destinationNode.channelCount = 1;
    this.destinationNode.channelCountMode = "explicit";
    this.destinationNode.channelInterpretation = "speakers";

    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.engineNode);
    this.engineNode.connect(this.vadGateNode);
    this.vadGateNode.connect(this.destinationNode);

    // LiveKit publishes this instead of the original track.
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  /** Tears down and rebuilds the graph, e.g. on a device change. */
  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  /** Updates the gate threshold. Safe while the processor is inactive. */
  setMicSensitivity(sensitivity: number): void {
    this.initialSensitivity = sensitivity;
    this.vadGateNode?.port.postMessage({ threshold: sensitivityToThreshold(sensitivity) });
  }

  /** 100 = unity, 200 = 2x. */
  setInputVolume(volume: number): void {
    this.initialInputVolume = volume;
    if (this.gainNode) {
      this.gainNode.gain.value = volume / 100;
    }
  }

  /** Disconnects every node and frees the engine's wasm memory. */
  async destroy(): Promise<void> {
    const disconnect = (fn: () => void) => {
      try {
        fn();
      } catch {
        /* already disconnected, or the worklet is gone */
      }
    };

    disconnect(() => this.sourceNode?.disconnect());
    disconnect(() => this.gainNode?.disconnect());
    disconnect(() => {
      this.engineNode?.disconnect();
      this.engineNode?.destroy();
    });
    disconnect(() => this.vadGateNode?.disconnect());
    disconnect(() => this.destinationNode?.disconnect());

    this.sourceNode = null;
    this.gainNode = null;
    this.engineNode = null;
    this.vadGateNode = null;
    this.destinationNode = null;
    this.processedTrack = undefined;
  }
}
