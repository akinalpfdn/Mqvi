/**
 * RNNoiseProcessor — RNNoise WASM tabanlı gürültü bastırma TrackProcessor'ı.
 *
 * LiveKit'in TrackProcessor<Track.Kind.Audio> interface'ini implement eder.
 * @sapphi-red/web-noise-suppressor paketi ile RNNoise WASM + AudioWorklet
 * kullanarak mikrofon sesinden gürültüyü (nefes, klavye, fan, AC) bastırır.
 *
 * Audio akışı:
 *   Mic Track → MediaStreamSource → RnnoiseWorkletNode → MediaStreamDestination → processedTrack
 *                                          ↑
 *                                     RNNoise WASM
 *                                 (ML-based denoising)
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
 */
const registeredContexts = new WeakMap<AudioContext, Promise<void>>();

function ensureWorkletRegistered(ctx: AudioContext): Promise<void> {
  let p = registeredContexts.get(ctx);
  if (!p) {
    p = ctx.audioWorklet.addModule(rnnoiseWorkletPath);
    registeredContexts.set(ctx, p);
  }
  return p;
}

class RNNoiseProcessor
  implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions>
{
  name = "rnnoise-noise-suppressor";
  processedTrack?: MediaStreamTrack;

  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private rnnoiseNode: RnnoiseWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  /**
   * init — Audio processing graph'ı kurar.
   *
   * LiveKit tarafından çağrılır: LocalAudioTrack.setProcessor() → init().
   * opts.audioContext LiveKit'in kendi AudioContext'idir (webAudioMix: true).
   * opts.track mikrofon MediaStreamTrack'idir.
   *
   * Sıra:
   * 1. WASM binary'yi yükle (cache'den veya fetch)
   * 2. AudioWorklet processor'ı register et (cache'den veya addModule)
   * 3. Input track → MediaStreamSource node
   * 4. RnnoiseWorkletNode oluştur (WASM tabanlı denoising)
   * 5. MediaStreamDestination node (output track üretir)
   * 6. Graph bağla: source → rnnoise → destination
   * 7. processedTrack'i set et → LiveKit bu track'i publish eder
   */
  async init(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    // 1. WASM binary yükle
    const wasmBinary = await getWasmBinary();

    // 2. AudioWorklet register et
    await ensureWorkletRegistered(audioContext);

    // 3. Input: mic track → source node
    const inputStream = new MediaStream([track]);
    this.sourceNode = audioContext.createMediaStreamSource(inputStream);

    // 4. RNNoise worklet node — ML denoising işlemi burada yapılır
    // maxChannels: 1 → mono mic input (stereo gereksiz, CPU tasarrufu)
    this.rnnoiseNode = new RnnoiseWorkletNode(audioContext, {
      wasmBinary,
      maxChannels: 1,
    });

    // 5. Output: destination node → temizlenmiş audio track
    this.destinationNode = audioContext.createMediaStreamDestination();

    // 6. Audio graph bağla: source → rnnoise → destination
    this.sourceNode.connect(this.rnnoiseNode);
    this.rnnoiseNode.connect(this.destinationNode);

    // 7. LiveKit bu track'i orijinal track yerine ağda publish eder
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

    this.sourceNode = null;
    this.rnnoiseNode = null;
    this.destinationNode = null;
    this.processedTrack = undefined;
  }
}

export { RNNoiseProcessor };
