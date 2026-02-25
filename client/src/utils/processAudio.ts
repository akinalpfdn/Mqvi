/**
 * processAudio.ts — Native WASAPI audio capture → MediaStreamTrack pipeline.
 *
 * Tauri Rust backend'deki WASAPI per-process capture'dan gelen PCM verilerini
 * AudioWorklet ile işleyerek LiveKit'e publish edilebilir MediaStreamTrack üretir.
 *
 * Pipeline:
 * ```
 * Rust WASAPI capture (48kHz stereo f32 → i16)
 *   → Tauri IPC event ("audio-pcm")
 *   → Main thread listen callback
 *   → AudioWorkletNode port.postMessage(Int16Array)
 *   → pcm-worklet-processor.js (audio thread, ring buffer)
 *   → MediaStreamAudioDestinationNode
 *   → MediaStreamTrack
 *   → localParticipant.publishTrack(track, { source: ScreenShareAudio })
 * ```
 *
 * Neden AudioWorklet?
 * ScriptProcessorNode deprecated ve main thread'de çalışır (jank riski).
 * AudioWorklet ayrı audio thread'de çalışır — production-grade, glitch-free.
 *
 * Neden bu class?
 * WASAPI capture yaşam döngüsünü (start/stop) ve tüm Web Audio bağlantılarını
 * tek bir yerde yönetir. VoiceStateManager sadece start/stop çağırır.
 *
 * Platform: Sadece Tauri desktop'ta çalışır. Browser'da start() hata fırlatır.
 */

import { isTauri } from "./constants";

/**
 * ProcessAudioCapture — Native per-process audio capture controller.
 *
 * Kullanım:
 * ```typescript
 * const capture = new ProcessAudioCapture();
 * const track = await capture.start();
 * // track'i LiveKit'e publish et
 * await localParticipant.publishTrack(track, { source: Track.Source.ScreenShareAudio });
 * // Bitirirken:
 * await capture.stop();
 * ```
 *
 * Kaynaklar start() ile oluşturulur, stop() ile temizlenir:
 * - AudioContext (48kHz)
 * - AudioWorkletNode (pcm-worklet-processor)
 * - MediaStreamAudioDestinationNode
 * - Tauri IPC listener
 * - Rust WASAPI capture thread
 */
export class ProcessAudioCapture {
  /** Web Audio context — 48kHz sample rate, WASAPI capture ile eşleşir. */
  private audioContext: AudioContext | null = null;

  /** AudioWorklet node — audio thread'de PCM → output dönüşümü yapar. */
  private workletNode: AudioWorkletNode | null = null;

  /**
   * Tauri IPC event listener cleanup fonksiyonu.
   * listen() async bir unlisten fonksiyonu döner — stop() sırasında çağrılır.
   */
  private unlisten: (() => void) | null = null;

  /**
   * Üretilen MediaStreamTrack — stop() sırasında track.stop() ile durdurulur.
   * Track durdurulmazsa AudioContext kapatılsa bile sistem kaynağı tüketir.
   */
  private outputTrack: MediaStreamTrack | null = null;

  /**
   * WASAPI capture başlat ve LiveKit'e publish edilebilir MediaStreamTrack döndür.
   *
   * Adımlar:
   * 1. Tauri ortamı kontrolü
   * 2. AudioContext (48kHz) oluştur
   * 3. pcm-worklet-processor.js modülünü AudioWorklet'e yükle
   * 4. AudioWorkletNode oluştur (stereo output)
   * 5. MediaStreamAudioDestinationNode'a bağla (WebRTC uyumlu track üretir)
   * 6. Tauri IPC "audio-pcm" event'ini dinle → worklet port'a aktar
   * 7. Rust capture'ı başlat (invoke("start_audio_capture"))
   * 8. destination.stream'den audio track'i döndür
   *
   * Hata durumları:
   * - Tauri ortamında değil: Error fırlatır
   * - AudioWorklet yükleme hatası: Error fırlatır
   * - Rust capture başlatma hatası: Error fırlatır, cleanup yapılır
   */
  async start(): Promise<MediaStreamTrack> {
    if (!isTauri()) {
      throw new Error("Process audio capture requires Tauri desktop environment");
    }

    // ─── 1. Tauri API'lerini dynamic import ile yükle ───
    // Dynamic import: Tauri modülleri sadece desktop'ta yüklenir.
    // Browser build'inde bu kod yoluna ulaşılmaz (isTauri() false döner).
    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");

    // ─── 2. AudioContext oluştur ───
    // sampleRate: 48000 — WASAPI capture format ile birebir eşleşir.
    // Farklı sample rate kullanılsaydı AudioContext resampling yapardı
    // (kalite kaybı + ekstra CPU). 48kHz→48kHz = zero-cost passthrough.
    this.audioContext = new AudioContext({ sampleRate: 48000 });

    try {
      // ─── 3. AudioWorklet modülünü yükle ───
      // addModule(): pcm-worklet-processor.js dosyasını audio thread'e yükler.
      // Dosya public/ klasöründe — Vite dev server ve production build'de
      // root path'ten servis edilir ("/pcm-worklet-processor.js").
      // Async: modül yüklenene kadar bekle — worklet node oluşturmadan önce
      // modülün hazır olması gerekir.
      await this.audioContext.audioWorklet.addModule("/pcm-worklet-processor.js");

      // ─── 4. AudioWorkletNode oluştur ───
      // "pcm-worklet-processor": registerProcessor() ile kaydedilen isim.
      // outputChannelCount: [2] — stereo output (sol + sağ kanal).
      // Tek output, 2 kanal — WASAPI'dan gelen interleaved stereo veri
      // worklet'te de-interleave edilip sol/sağ kanallara yazılır.
      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        "pcm-worklet-processor",
        { outputChannelCount: [2] }
      );

      // ─── 5. MediaStreamAudioDestinationNode'a bağla ───
      // createMediaStreamDestination(): Web Audio graph'ından WebRTC uyumlu
      // MediaStream üretir. Bu stream'in audio track'i doğrudan
      // LiveKit publishTrack() ile yayınlanabilir.
      //
      // Neden bu node gerekli?
      // AudioWorkletNode'un çıkışı Web Audio graph'ında kalır — dış dünya
      // (WebRTC, LiveKit) erişemez. MediaStreamDestination bu köprüyü sağlar:
      // Web Audio output → MediaStreamTrack → WebRTC/LiveKit
      const destination = this.audioContext.createMediaStreamDestination();
      this.workletNode.connect(destination);

      // ─── 6. Tauri IPC event dinle ───
      // Rust capture loop'u 20ms'de bir "audio-pcm" event'i emit eder.
      // Payload: { samples: number[] } — i16 PCM sample dizisi (1920 eleman).
      //
      // listen() async bir unlisten fonksiyonu döner — event listener'ı
      // kaldırmak için stop() sırasında çağrılır.
      //
      // number[] → Int16Array dönüşümü: worklet processor i16 formatında bekler.
      // postMessage ile transferable olarak gönderilir (zero-copy).
      this.unlisten = await listen<{ samples: number[] }>("audio-pcm", (event) => {
        if (this.workletNode) {
          const i16 = new Int16Array(event.payload.samples);
          this.workletNode.port.postMessage({ samples: i16 }, [i16.buffer]);
        }
      });

      // ─── 7. Rust WASAPI capture başlat ───
      // invoke("start_audio_capture"): Rust tarafında AudioCapture.start() çağırır.
      // Background thread başlatılır, "audio-pcm" event'leri akmaya başlar.
      await invoke("start_audio_capture");

      // ─── 8. Audio track'i sakla ve döndür ───
      // getAudioTracks()[0]: destination stream'in ilk (ve tek) audio track'i.
      // Bu track LiveKit'e publish edilecek.
      this.outputTrack = destination.stream.getAudioTracks()[0];
      return this.outputTrack;
    } catch (err) {
      // Hata durumunda oluşturulan kaynakları temizle
      await this.stop();
      throw err;
    }
  }

  /**
   * Capture durdur ve tüm kaynakları temizle.
   *
   * Sıralı cleanup:
   * 1. Rust WASAPI capture → durdur (IPC event akışı durur)
   * 2. Tauri IPC listener → kaldır (event handler temizlenir)
   * 3. AudioWorklet → disconnect (audio graph bağlantısı kesilir)
   * 4. MediaStreamTrack → stop (sistem kaynağı serbest bırakılır)
   * 5. AudioContext → close (Web Audio kaynakları temizlenir)
   *
   * Her adım bağımsız try-catch ile korunur — bir adımın hatası
   * diğerlerinin çalışmasını engellemez.
   */
  async stop(): Promise<void> {
    // 1. Rust capture durdur
    try {
      if (isTauri()) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("stop_audio_capture");
      }
    } catch (err) {
      console.error("[ProcessAudioCapture] Failed to stop Rust capture:", err);
    }

    // 2. IPC listener kaldır
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }

    // 3. AudioWorklet disconnect
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    // 4. MediaStreamTrack durdur
    if (this.outputTrack) {
      this.outputTrack.stop();
      this.outputTrack = null;
    }

    // 5. AudioContext kapat
    if (this.audioContext) {
      try {
        await this.audioContext.close();
      } catch {
        // Context zaten kapalıysa veya hata olursa sessizce geç
      }
      this.audioContext = null;
    }
  }
}
