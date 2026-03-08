/**
 * VadGateProcessor — Energy-based voice activity gate (AudioWorklet).
 *
 * Inserted after RNNoise in the pipeline. Computes RMS energy per frame
 * and outputs silence when below threshold (cuts breath, light noise).
 *
 * Attack/Release:
 * - Attack (~5ms): gate opens quickly so first syllables aren't clipped.
 * - Release (~200ms): gate closes slowly so word endings aren't cut.
 *   Short pauses between words keep the gate open.
 *
 * Threshold is updated from main thread via port.postMessage({ threshold }).
 *
 * Pipeline: RNNoise -> [VadGateProcessor] -> Destination
 */

class VadGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // RMS energy threshold — frames below this are silenced. 0 = gate disabled.
    this._threshold = 0;

    // Gate level: 0.0 (closed/silent) -> 1.0 (open/passing audio)
    this._gateLevel = 0.0;

    // Attack/release coefficients assuming 48kHz sampleRate.
    // Formula: coeff = 1 - exp(-1 / (time_seconds * sampleRate / blockSize))
    // blockSize = 128 (WebAudio standard), frames_per_second = 48000 / 128 = 375
    this._attackCoeff = 1.0 - Math.exp(-1.0 / (0.005 * 375)); // ~5ms
    this._releaseCoeff = 1.0 - Math.exp(-1.0 / (0.200 * 375)); // ~200ms

    this.port.onmessage = (event) => {
      if (typeof event.data.threshold === "number") {
        this._threshold = event.data.threshold;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0]) return true;

    // Gate disabled — pass-through
    if (this._threshold <= 0) {
      for (let ch = 0; ch < input.length; ch++) {
        if (output[ch]) {
          output[ch].set(input[ch]);
        }
      }
      return true;
    }

    // Compute RMS energy (first channel — mono mic)
    const samples = input[0];
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSq / samples.length);

    // Update gate envelope
    if (rms >= this._threshold) {
      // Voice detected — open gate (attack)
      this._gateLevel += this._attackCoeff * (1.0 - this._gateLevel);
    } else {
      // Silence — close gate (release)
      this._gateLevel += this._releaseCoeff * (0.0 - this._gateLevel);
    }

    // Snap very low levels to zero (prevent denormalized floats)
    if (this._gateLevel < 0.001) {
      this._gateLevel = 0.0;
    }

    // Output = input * gateLevel
    for (let ch = 0; ch < input.length; ch++) {
      if (!output[ch]) continue;
      const inp = input[ch];
      const out = output[ch];
      for (let i = 0; i < inp.length; i++) {
        out[i] = inp[i] * this._gateLevel;
      }
    }

    return true;
  }
}

registerProcessor("vad-gate-processor", VadGateProcessor);
