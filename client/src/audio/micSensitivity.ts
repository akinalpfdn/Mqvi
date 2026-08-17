/**
 * micSensitivity — the one mapping from the user's sensitivity slider to a VAD gate threshold.
 *
 * Lived in two copies before (RNNoiseProcessor and VadGateProcessor), which is a quiet way for the
 * gate to behave differently depending on which processor happens to be running.
 */

/**
 * Converts micSensitivity (0-100) to an RMS threshold using a quadratic curve.
 *
 *   100 -> 0      (gate disabled)
 *   75  -> 0.0025 (very light gate)
 *   50  -> 0.01   (moderate)
 *   25  -> 0.0225 (aggressive)
 *   0   -> 0.04   (very aggressive)
 *
 * Quadratic because hearing is logarithmic — low sensitivity needs the finer control.
 */
export function sensitivityToThreshold(sensitivity: number): number {
  const clamped = Math.max(0, Math.min(100, sensitivity));
  const inverted = (100 - clamped) / 100;
  return 0.04 * inverted * inverted;
}
