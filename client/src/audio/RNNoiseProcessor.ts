/**
 * RNNoiseProcessor — RNNoise WASM tabanlı gürültü bastırma + VAD gate TrackProcessor'ı.
 *
 * LiveKit'in TrackProcessor<Track.Kind.Audio> interface'ini implement eder.
 * @sapphi-red/web-noise-suppressor paketi ile RNNoise WASM + AudioWorklet
 * kullanarak mikrofon sesinden gürültüyü (nefes, klavye, fan, AC) bastırır.
 *
 * Audio akışı:
 *   Mic Track → MediaStreamSource → RnnoiseWorkletNode → VadGateNode → MediaStreamDestination
 *                                          ↑                    ↑
 *                                     RNNoise WASM        Energy-based gate
 *                                 (ML-based denoising)    (micSensitivity ile kontrol)
 *
 * VAD Gate nedir?
 * RNNoise gürültüyü temizledikten sonra kalan sinyalin RMS enerjisini ölçer.
 * Enerji threshold altındaysa (konuşma yok) sessizlik çıkarır.
 * Bu sayede nefes sesi gibi RNNoise'un tam kesertemediği hafif sesler de kesilir.
 * Attack (~5ms) ve release (~200ms) ile kelime başları/sonları kesilmez.
 *
 * micSensitivity (0-100) mapping:
 * - 100 = en hassas (gate devre dışı, her şey geçer)
 * - 50 = moderate (nefes kesilir, konuşma geçer)
 * - 0 = en agresif (sadece net konuşma geçer)
 *
 * RNNoise nedir?
 * Mozilla/Xiph tarafından geliştirilen, neural network tabanlı ses temizleme.
 * WebRTC'nin built-in noiseSuppression'ından çok daha agresif — nefes sesi,
 * klavye tıklaması gibi düzensiz gürültüleri de etkili biçimde bastırır.
 * WASM'a derlenip AudioWorklet'te çalışır → main thread bloke olmaz.
 *
 * Yaşam döngüsü:
 * 1. init(): WASM yükle → AudioWorklet register → audio graph kur
 * 2. restart(): Mevcut graph'ı yık, yeniden kur (track değişimlerinde)
 * 3. destroy(): Tüm node'ları disconnect, kaynakları serbest bırak
 *
 * LocalAudioTrack.setProcessor(new RNNoiseProcessor()) ile kullanılır.
 * LiveKit, processedTrack'i ağ üzerinden publish eder (orijinal track yerine).
 */

import { Track } from "livekit-client";
import type { TrackProcessor, AudioProcessorOptions } from "livekit-client";
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";

// Vite ?url import'ları — dosya URL'lerini build zamanında resolve eder.
// AudioWorklet.addModule() ve fetch() ile yüklenecek URL'ler.
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

// VAD gate worklet — enerji tabanlı ses kapısı
import vadGateWorkletPath from "./vadGateWorklet.js?url";

/**
 * WASM binary cache — birden fazla init() çağrısında tekrar yüklenmesini önler.
 * İlk yüklemeden sonra Promise resolve olur ve sonraki çağrılarda
 * hemen cached değer döner. Module-level tutulur çünkü WASM binary'si
 * tüm processor instance'ları arasında paylaşılabilir (stateless).
 */
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;

function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadRnnoise({
      url: rnnoiseWasmPath,
      simdUrl: rnnoiseSimdWasmPath,
    });
  }
  return wasmBinaryPromise;
}

/**
 * AudioWorklet registration cache — aynı AudioContext'e birden fazla
 * addModule() çağrısı yapılmasını önler. WeakMap kullanılır çünkü
 * AudioContext garbage collect olursa registration da temizlensin.
 *
 * Her worklet (rnnoise + vadGate) ayrı key ile takip edilir.
 */
const registeredContexts = new WeakMap<AudioContext, Map<string, Promise<void>>>();

function ensureWorkletRegistered(ctx: AudioContext, name: string, url: string): Promise<void> {
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

/**
 * sensitivityToThreshold — micSensitivity (0-100) değerini RMS threshold'a çevirir.
 *
 * Mapping (quadratic):
 *   sensitivity 100 → threshold 0     (gate devre dışı, her şey geçer)
 *   sensitivity 75  → threshold 0.0025 (çok hafif gate)
 *   sensitivity 50  → threshold 0.01   (moderate — nefes kesilir, konuşma geçer)
 *   sensitivity 25  → threshold 0.0225 (agresif)
 *   sensitivity 0   → threshold 0.04   (çok agresif — sadece net konuşma)
 *
 * Neden quadratic?
 * İnsan ses algısı logaritmik — düşük sensitivity'lerde daha hassas kontrol gerekir.
 * Linear mapping düşük değerlerde çok agresif, yüksek değerlerde etkisiz olurdu.
 */
function sensitivityToThreshold(sensitivity: number): number {
  const clamped = Math.max(0, Math.min(100, sensitivity));
  const inverted = (100 - clamped) / 100; // 0→1 (sensitivity 100→0)
  return 0.04 * inverted * inverted; // quadratic curve, max 0.04
}

class RNNoiseProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = "rnnoise-noise-suppressor";
  processedTrack?: MediaStreamTrack;

  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  private vadGateNode: AudioWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  /** Başlangıç micSensitivity değeri — constructor'da set edilir, init'te uygulanır */
  private initialSensitivity: number;

  constructor(micSensitivity = 50) {
    this.initialSensitivity = micSensitivity;
  }

  /**
   * init — Audio processing graph'ı kurar.
   *
   * LiveKit tarafından çağrılır: LocalAudioTrack.setProcessor() → init().
   * opts.audioContext LiveKit'in kendi AudioContext'idir (webAudioMix: true).
   * opts.track mikrofon MediaStreamTrack'idir.
   *
   * Sıra:
   * 1. WASM binary'yi yükle (cache'den veya fetch)
   * 2. AudioWorklet processor'ları register et (rnnoise + vadGate)
   * 3. Input track → MediaStreamSource node
   * 4. RnnoiseWorkletNode oluştur (WASM tabanlı denoising)
   * 5. VadGateNode oluştur (enerji tabanlı ses kapısı)
   * 6. MediaStreamDestination node (output track üretir)
   * 7. Graph bağla: source → rnnoise → vadGate → destination
   * 8. processedTrack'i set et → LiveKit bu track'i publish eder
   */
  async init(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    // 1. WASM binary yükle
    const wasmBinary = await getWasmBinary();

    // 2. AudioWorklet'leri register et (paralel)
    await Promise.all([
      ensureWorkletRegistered(audioContext, "rnnoise", rnnoiseWorkletPath),
      ensureWorkletRegistered(audioContext, "vad-gate", vadGateWorkletPath),
    ]);

    // 3. Input: mic track → source node
    const inputStream = new MediaStream([track]);
    this.sourceNode = audioContext.createMediaStreamSource(inputStream);

    // 4. RNNoise worklet node — ML denoising işlemi burada yapılır
    // maxChannels: 1 → mono mic input (stereo gereksiz, CPU tasarrufu)
    this.rnnoiseNode = new RnnoiseWorkletNode(audioContext, {
      wasmBinary,
      maxChannels: 1,
    });

    // 5. VAD gate node — enerji tabanlı ses kapısı
    this.vadGateNode = new AudioWorkletNode(audioContext, "vad-gate-processor");
    // Başlangıç threshold'unu set et
    this.setMicSensitivity(this.initialSensitivity);

    // 6. Output: destination node → temizlenmiş + gate'lenmiş audio track
    this.destinationNode = audioContext.createMediaStreamDestination();

    // 7. Audio graph bağla: source → rnnoise → vadGate → destination
    this.sourceNode.connect(this.rnnoiseNode);
    this.rnnoiseNode.connect(this.vadGateNode);
    this.vadGateNode.connect(this.destinationNode);

    // 8. LiveKit bu track'i orijinal track yerine ağda publish eder
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];
  }

  /**
   * restart — Track değiştiğinde (örn. cihaz değişimi) graph'ı yeniden kurar.
   * Mevcut graph tamamen yıkılıp sıfırdan oluşturulur.
   */
  async restart(opts: AudioProcessorOptions): Promise<void> {
    await this.destroy();
    await this.init(opts);
  }

  /**
   * setMicSensitivity — VAD gate threshold'unu günceller.
   *
   * micSensitivity (0-100) → RMS threshold çevirimi yapar ve
   * AudioWorklet'e postMessage ile gönderir.
   * Processor aktif değilken de çağrılabilir — node yoksa sessizce geçer.
   */
  setMicSensitivity(sensitivity: number): void {
    this.initialSensitivity = sensitivity;
    if (this.vadGateNode) {
      const threshold = sensitivityToThreshold(sensitivity);
      this.vadGateNode.port.postMessage({ threshold });
    }
  }

  /**
   * destroy — Tüm audio node'ları disconnect eder ve kaynakları serbest bırakır.
   *
   * RnnoiseWorkletNode.destroy() WASM belleğini serbest bırakır.
   * Node disconnect'leri AudioContext'teki referansları temizler.
   */
  async destroy(): Promise<void> {
    try {
      this.sourceNode?.disconnect();
    } catch {
      // Zaten disconnect olmuş olabilir
    }

    try {
      this.rnnoiseNode?.disconnect();
      this.rnnoiseNode?.destroy();
    } catch {
      // Worklet zaten kapatılmış olabilir
    }

    try {
      this.vadGateNode?.disconnect();
    } catch {
      // Zaten disconnect olmuş olabilir
    }

    try {
      this.destinationNode?.disconnect();
    } catch {
      // Zaten disconnect olmuş olabilir
    }

    this.sourceNode = null;
    this.rnnoiseNode = null;
    this.vadGateNode = null;
    this.destinationNode = null;
    this.processedTrack = undefined;
  }
}

export { RNNoiseProcessor };
