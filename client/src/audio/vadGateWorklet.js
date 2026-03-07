/**
 * VadGateProcessor — Enerji tabanlı ses kapısı (voice activity gate).
 *
 * RNNoise'dan sonra pipeline'a eklenir. Her audio frame'in RMS enerjisini
 * hesaplar ve threshold altındaysa sessizlik çıkarır (nefes, hafif gürültü kesilir).
 *
 * Attack/Release mekanizması:
 * - Attack (~5ms): Konuşma başladığında kapı hızlıca açılır — ilk hece kesilmez.
 * - Release (~200ms): Konuşma bitince kapı yavaşça kapanır — kelime sonları kesilmez.
 *   Kısa duraklamalar (kelimeler arası) boyunca kapı açık kalır.
 *
 * Threshold, main thread'den port.postMessage({ threshold }) ile güncellenir.
 * micSensitivity (0-100) → threshold mapping main thread'de yapılır.
 *
 * Audio akışı: RNNoise → [VadGateProcessor] → Destination
 */

class VadGateProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // RMS enerji eşiği — bu değerin altındaki frame'ler sessizliğe çevrilir.
    // 0 = gate devre dışı (her şey geçer).
    this._threshold = 0;

    // Gate durumu: 0.0 (kapalı/sessiz) → 1.0 (açık/ses geçiyor)
    this._gateLevel = 0.0;

    // Attack/Release katsayıları — sampleRate 48000 varsayımıyla.
    // Attack: ~5ms → kapı hızlı açılır (konuşma başlangıcı kesilmesin)
    // Release: ~200ms → kapı yavaş kapanır (kelime sonları kesilmesin)
    //
    // Formül: coeff = 1 - exp(-1 / (time_seconds * sampleRate / blockSize))
    // blockSize = 128 (WebAudio standard), sampleRate = 48000
    // frames_per_second = 48000 / 128 = 375
    this._attackCoeff = 1.0 - Math.exp(-1.0 / (0.005 * 375)); // ~5ms
    this._releaseCoeff = 1.0 - Math.exp(-1.0 / (0.200 * 375)); // ~200ms

    // Main thread'den threshold güncellemeleri
    this.port.onmessage = (event) => {
      if (typeof event.data.threshold === "number") {
        this._threshold = event.data.threshold;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // Input yoksa veya gate devre dışıysa (threshold 0) → pass-through
    if (!input || !input[0]) return true;

    if (this._threshold <= 0) {
      // Gate devre dışı — sesi olduğu gibi geçir
      for (let ch = 0; ch < input.length; ch++) {
        if (output[ch]) {
          output[ch].set(input[ch]);
        }
      }
      return true;
    }

    // RMS enerji hesapla (ilk kanal üzerinden — mono mic)
    const samples = input[0];
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSq / samples.length);

    // Gate envelope güncelle
    if (rms >= this._threshold) {
      // Ses var → kapıyı aç (attack)
      this._gateLevel += this._attackCoeff * (1.0 - this._gateLevel);
    } else {
      // Sessizlik → kapıyı kapat (release)
      this._gateLevel += this._releaseCoeff * (0.0 - this._gateLevel);
    }

    // Çok düşük gate seviyesini sıfıra snap et (denormalized float önleme)
    if (this._gateLevel < 0.001) {
      this._gateLevel = 0.0;
    }

    // Output: input * gateLevel
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
