/**
 * pcm-feeder-processor.js — AudioWorklet processor for native audio capture.
 *
 * Receives raw PCM float32 data from the main thread via port.postMessage()
 * and outputs it through the AudioWorklet's output channels.
 *
 * Data flow:
 *   native audio-capture.exe → Electron main → IPC → renderer → port.postMessage()
 *   → this processor's ring buffer → AudioContext output → MediaStreamDestination
 *   → LiveKit publishes as ScreenShareAudio track
 *
 * Ring buffer design:
 *   - Fixed-size Float32Array ring buffer per channel
 *   - Write pointer advances when new data arrives via port
 *   - Read pointer advances each process() call (128 frames at a time)
 *   - If read catches up to write → output silence (underrun)
 *   - If write gets too far ahead → drop oldest data (overrun)
 *
 * Expected input format: interleaved float32 PCM (e.g. L R L R L R ...)
 * Channel count is configured via processorOptions.channelCount (default: 2)
 */

class PCMFeederProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // Channel count from processor options (default stereo)
    this.channels = options.processorOptions?.channelCount || 2;

    // Ring buffer: 1 second of audio at the worklet's sample rate
    // sampleRate is a global in AudioWorkletGlobalScope
    this.bufferSize = sampleRate * 2; // 2 seconds for safety margin
    this.ringBuffers = [];
    for (let ch = 0; ch < this.channels; ch++) {
      this.ringBuffers.push(new Float32Array(this.bufferSize));
    }

    this.writePos = 0;
    this.readPos = 0;
    this.available = 0; // frames available to read

    // Receive PCM data from main thread
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data instanceof Float32Array) {
        this._writeInterleaved(data);
      }
    };
  }

  /**
   * Write interleaved float32 PCM data into the ring buffer.
   * Input: [L0, R0, L1, R1, L2, R2, ...] for stereo
   */
  _writeInterleaved(interleaved) {
    const channels = this.channels;
    const frames = Math.floor(interleaved.length / channels);

    for (let i = 0; i < frames; i++) {
      const pos = (this.writePos + i) % this.bufferSize;
      for (let ch = 0; ch < channels; ch++) {
        this.ringBuffers[ch][pos] = interleaved[i * channels + ch];
      }
    }

    this.writePos = (this.writePos + frames) % this.bufferSize;
    this.available = Math.min(this.available + frames, this.bufferSize);
  }

  /**
   * AudioWorklet process callback — called ~375 times/sec at 48kHz
   * (128 frames per call). Reads from ring buffer into output channels.
   */
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const numFrames = output[0].length; // typically 128

    if (this.available >= numFrames) {
      // Normal case: enough data in buffer
      for (let ch = 0; ch < output.length && ch < this.channels; ch++) {
        const outChannel = output[ch];
        const ringBuffer = this.ringBuffers[ch];
        for (let i = 0; i < numFrames; i++) {
          outChannel[i] = ringBuffer[(this.readPos + i) % this.bufferSize];
        }
      }
      this.readPos = (this.readPos + numFrames) % this.bufferSize;
      this.available -= numFrames;
    } else {
      // Underrun: not enough data, output silence
      for (let ch = 0; ch < output.length; ch++) {
        output[ch].fill(0);
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor("pcm-feeder", PCMFeederProcessor);
