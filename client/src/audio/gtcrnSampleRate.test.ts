import { describe, it, expect } from "vitest";
import { gtcrnSupportsSampleRate, GtcrnUnsupportedSampleRateError } from "./gtcrnSampleRate";

// The worklet accepts 16 and 48 kHz and throws on anything else — inside an async IIFE with no
// catch, where the rejection reaches nobody. The node still constructs, `setProcessor` still
// resolves, and `process()` leaves the output buffer untouched: the microphone goes silent and
// nothing is reported. LiveKit builds its context with a bare `new AudioContext()`, so the rate is
// the hardware's choice and 44.1 kHz is ordinary. This guard is what keeps that from shipping.

describe("gtcrnSupportsSampleRate", () => {
  it("should accept the two rates the worklet implements", () => {
    expect(gtcrnSupportsSampleRate(16000)).toBe(true);
    expect(gtcrnSupportsSampleRate(48000)).toBe(true);
  });

  // The rate that actually turns up: macOS built-in output and a great many headsets.
  it("should reject 44.1 kHz", () => {
    expect(gtcrnSupportsSampleRate(44100)).toBe(false);
  });

  it("should reject other plausible hardware rates", () => {
    expect(gtcrnSupportsSampleRate(22050)).toBe(false);
    expect(gtcrnSupportsSampleRate(88200)).toBe(false);
    expect(gtcrnSupportsSampleRate(96000)).toBe(false);
  });
});

describe("GtcrnUnsupportedSampleRateError", () => {
  // The caller matches on the type to decide between falling back and logging a real failure, so
  // `instanceof` has to survive the subclass — TS targeting ES5 famously breaks it.
  it("should be recognisable with instanceof", () => {
    const err = new GtcrnUnsupportedSampleRateError(44100);

    expect(err instanceof GtcrnUnsupportedSampleRateError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it("should carry the rate that was rejected", () => {
    expect(new GtcrnUnsupportedSampleRateError(44100).sampleRate).toBe(44100);
  });

  it("should name the rate in the message", () => {
    expect(new GtcrnUnsupportedSampleRateError(44100).message).toContain("44100");
  });
});
