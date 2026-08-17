/**
 * RNNoiseProcessor — the "Standard" engine: RNNoise WASM + the shared VAD gate.
 *
 * Full-band: the model works at the context's own 48 kHz, so nothing is resampled and no part of
 * the voice is lost. Strong at steady noise — fan, hum, air conditioning. Weak at transients:
 * RNNoise applies gains to 22 Bark bands, so when speech and a keyboard click occupy the same band
 * in the same frame its only move is to attenuate both. That limit is what GtcrnProcessor exists
 * for; it is a property of the model's shape, not of its training.
 *
 * The graph lives in DenoiseProcessorBase.
 */

import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";

// Vite ?url imports — resolved at build time for AudioWorklet.addModule() and fetch()
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

import {
  DenoiseProcessorBase,
  ensureWorkletRegistered,
  type DenoiseEngineNode,
} from "./DenoiseProcessorBase";

/** WASM binary cache — the module is stateless, so every instance can share one fetch. */
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadRnnoise({ url: rnnoiseWasmPath, simdUrl: rnnoiseSimdWasmPath });
  }
  return wasmBinaryPromise;
}

class RNNoiseProcessor extends DenoiseProcessorBase {
  name = "rnnoise-noise-suppressor";

  protected async prepareEngine(ctx: AudioContext): Promise<ArrayBuffer> {
    const [wasmBinary] = await Promise.all([
      getWasmBinary(),
      ensureWorkletRegistered(ctx, "rnnoise", rnnoiseWorkletPath),
    ]);
    return wasmBinary;
  }

  protected createEngineNode(ctx: AudioContext, wasmBinary: ArrayBuffer): DenoiseEngineNode {
    return new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
  }
}

export { RNNoiseProcessor };
