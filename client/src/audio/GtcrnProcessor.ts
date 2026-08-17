/**
 * GtcrnProcessor — the "Strong" engine: GTCRN WASM + the shared VAD gate.
 *
 * Removes what RNNoise structurally cannot: keyboard, background speech, transients. GTCRN is a
 * mask-based subband model, so it can separate a click from speech sharing the same band rather
 * than attenuating both (PESQ 2.87 vs 2.29 on VCTK-DEMAND, at roughly a tenth of DeepFilterNet's
 * compute).
 *
 * The cost is bandwidth, and it is not subtle: the model runs at 16 kHz. The wasm resamples the
 * 48 kHz input down, denoises, and upsamples the result — so everything above 8 kHz is gone and
 * the upsample does not bring it back. Voices come out duller than on Standard. That is why this
 * is a mode the user picks rather than an upgrade applied to everyone.
 *
 * The graph lives in DenoiseProcessorBase.
 */

import { GtcrnWorkletNode, loadGtcrn } from "@sapphi-red/web-noise-suppressor";

// Vite ?url imports — resolved at build time for AudioWorklet.addModule() and fetch()
import gtcrnWorkletPath from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url";
import gtcrnWasmPath from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?url";

import {
  DenoiseProcessorBase,
  ensureWorkletRegistered,
  type DenoiseEngineNode,
} from "./DenoiseProcessorBase";
import { gtcrnSupportsSampleRate, GtcrnUnsupportedSampleRateError } from "./gtcrnSampleRate";

/** WASM binary cache — the module is stateless, so every instance can share one fetch. */
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadGtcrn({ url: gtcrnWasmPath });
  }
  return wasmBinaryPromise;
}

class GtcrnProcessor extends DenoiseProcessorBase {
  name = "gtcrn-noise-suppressor";

  protected async prepareEngine(ctx: AudioContext): Promise<ArrayBuffer> {
    // Before the fetch and before the worklet: the context's rate comes from the hardware
    // (LiveKit builds it with a bare `new AudioContext()`), and 44.1 kHz is ordinary on macOS
    // and on plenty of headsets.
    if (!gtcrnSupportsSampleRate(ctx.sampleRate)) {
      throw new GtcrnUnsupportedSampleRateError(ctx.sampleRate);
    }

    const [wasmBinary] = await Promise.all([
      getWasmBinary(),
      ensureWorkletRegistered(ctx, "gtcrn", gtcrnWorkletPath),
    ]);
    return wasmBinary;
  }

  protected createEngineNode(ctx: AudioContext, wasmBinary: ArrayBuffer): DenoiseEngineNode {
    return new GtcrnWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
  }
}

export { GtcrnProcessor };
