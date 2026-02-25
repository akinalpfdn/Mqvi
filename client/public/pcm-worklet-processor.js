/**
 * pcm-worklet-processor.js — AudioWorklet processor for native PCM audio.
 *
 * Tauri IPC'den gelen i16 PCM chunk'ları alır ve Web Audio output'una yazar.
 * AudioWorklet, ScriptProcessorNode'un modern alternatifi:
 * - Ayrı audio thread'de çalışır (main thread bloklanmaz)
 * - Deterministik 128-sample bloklar (glitch-free)
 * - Production-grade ses işleme
 *
 * Veri akışı:
 * Rust WASAPI → Tauri IPC → main thread listen() → port.postMessage(Int16Array)
 * → Bu processor (audio thread) → ring buffer → process() → audio output
 * → MediaStreamAudioDestinationNode → MediaStreamTrack → LiveKit publishTrack
 *
 * Ring Buffer neden gerekli?
 * Tauri IPC event'leri düzensiz aralıklarla gelir (~20ms ama jitter olabilir).
 * AudioWorklet process() callback'i ise sabit 128-sample bloklarla çağrılır
 * (~2.67ms @ 48kHz). Ring buffer bu zamanlama farkını absorbe eder.
 * Buffer boşsa silence (0) yazılır — click/pop yerine sessizlik tercih edilir.
 *
 * Format: 48kHz, stereo (2 kanal), i16 → f32 normalize
 * i16 aralığı: [-32768, 32767] → f32 aralığı: [-1.0, 1.0]
 * Dönüşüm: f32_sample = i16_sample / 32768.0
 */

class PcmWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /**
     * Ring buffer: Float32Array olarak tutulan interleaved stereo samples.
     * Başlangıç boyutu: 960 × 2 × 4 chunk = 7680 sample (160ms tampon).
     * 160ms: ~8 chunk'lık buffer — IPC jitter'ı absorbe etmek için yeterli.
     * Dinamik büyümez — sabit boyut, circular write/read.
     */
    this._bufferSize = 960 * 2 * 4;
    this._buffer = new Float32Array(this._bufferSize);

    /**
     * Ring buffer pointer'ları:
     * _writePos: Sonraki yazma pozisyonu (IPC'den veri gelince)
     * _readPos: Sonraki okuma pozisyonu (process() callback'inde)
     * _available: Buffer'daki okunabilir sample sayısı
     *
     * Neden ayrı _available counter?
     * writePos === readPos durumunda buffer boş mu dolu mu belirsiz.
     * Ayrı counter ile bu ambiguity çözülür.
     */
    this._writePos = 0;
    this._readPos = 0;
    this._available = 0;

    /**
     * Main thread'den gelen mesajları dinle.
     * Mesaj formatı: { samples: Int16Array }
     * Int16Array → Float32Array dönüşümü burada yapılır (audio thread'de).
     */
    this.port.onmessage = (event) => {
      const i16Samples = event.data.samples;
      if (!i16Samples || i16Samples.length === 0) return;

      // i16 → f32 dönüşüm: [-32768, 32767] → [-1.0, 1.0]
      // 32768.0 ile böl (32767 değil) — negatif tarafta -1.0 tam karşılık gelsin
      const count = i16Samples.length;
      for (let i = 0; i < count; i++) {
        this._buffer[this._writePos] = i16Samples[i] / 32768.0;
        this._writePos = (this._writePos + 1) % this._bufferSize;
      }

      // Overflow kontrolü: yeni veri eski verinin üzerine yazarsa
      // _available buffer boyutunu aşamaz — en fazla tam dolu olabilir
      this._available = Math.min(this._available + count, this._bufferSize);
    };
  }

  /**
   * AudioWorklet process callback — audio thread tarafından çağrılır.
   *
   * Her çağrıda 128 frame (128 × 2 kanal = 256 sample) üretmemiz gerekir.
   * Web Audio API bunu ~2.67ms'de bir çağırır (48000 / 128 = 375 Hz).
   *
   * @param _inputs - Kullanılmıyor (input kaynağımız yok, veri port'tan geliyor)
   * @param outputs - outputs[0] = stereo output, outputs[0][0] = sol kanal, outputs[0][1] = sağ kanal
   * @returns {boolean} true = processor'ı canlı tut, false = kapat
   */
  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;

    const left = output[0];
    const right = output[1];
    const frames = left.length; // 128 frame (Web Audio standart blok boyutu)

    // Buffer'da yeterli veri var mı?
    // Stereo interleaved: her frame 2 sample (L + R)
    const samplesNeeded = frames * 2;

    if (this._available >= samplesNeeded) {
      // Veri mevcut — ring buffer'dan oku ve de-interleave et
      // Interleaved [L, R, L, R, ...] → ayrı [L, L, ...] ve [R, R, ...] kanalları
      for (let i = 0; i < frames; i++) {
        left[i] = this._buffer[this._readPos];
        this._readPos = (this._readPos + 1) % this._bufferSize;
        right[i] = this._buffer[this._readPos];
        this._readPos = (this._readPos + 1) % this._bufferSize;
      }
      this._available -= samplesNeeded;
    } else {
      // Buffer boş veya yetersiz — silence yaz
      // Click/pop yerine sessizlik tercih edilir.
      // Bu durum normalde sadece başlangıçta veya IPC kesintisinde olur.
      for (let i = 0; i < frames; i++) {
        left[i] = 0;
        right[i] = 0;
      }
    }

    // true: processor'ı canlı tut (false dönerse AudioWorklet sonlandırılır)
    return true;
  }
}

// AudioWorklet modül sistemi: registerProcessor ile processor'ı kaydet.
// İsim ("pcm-worklet-processor") AudioWorkletNode oluşturulurken kullanılır.
registerProcessor("pcm-worklet-processor", PcmWorkletProcessor);
