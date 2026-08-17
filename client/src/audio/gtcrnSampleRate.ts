/**
 * gtcrnSampleRate — what GTCRN can run on, and the error for when it cannot.
 *
 * Its own module so the check is reachable without importing the worklet library: that library
 * touches `AudioWorkletNode` at module scope, which does not exist outside a browser, and pulling
 * it in would make this untestable.
 */

/**
 * The only two rates the GTCRN worklet implements — the model runs at 16 kHz and there is a 48 kHz
 * path that resamples around it. On anything else the worklet throws inside an async IIFE with no
 * catch: the node still constructs, `setProcessor` still resolves, and `process()` leaves the
 * output buffer untouched. That is a microphone that goes silent with nothing reported, so the rate
 * is checked before a node exists.
 *
 * Not a rare case. LiveKit builds its context with a bare `new AudioContext()`, so the rate is
 * whatever the hardware prefers — 44.1 kHz on macOS built-in output and on many headsets.
 */
const SUPPORTED_SAMPLE_RATES = [16000, 48000];

export function gtcrnSupportsSampleRate(sampleRate: number): boolean {
  return SUPPORTED_SAMPLE_RATES.includes(sampleRate);
}

/** Thrown before any node is built, so the caller can fall back rather than publish silence. */
export class GtcrnUnsupportedSampleRateError extends Error {
  readonly sampleRate: number;

  constructor(sampleRate: number) {
    super(`GTCRN supports only ${SUPPORTED_SAMPLE_RATES.join("/")} Hz, got ${sampleRate} Hz`);
    this.name = "GtcrnUnsupportedSampleRateError";
    this.sampleRate = sampleRate;
  }
}
