/// WASAPI per-process audio capture module.
///
/// Windows WASAPI API'nin PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
/// modunu kullanarak kendi uygulamamızın ses çıkışını hariç tutup geri kalan
/// tüm sistem sesini yakalar. Bu sayede ekran paylaşımında voice chat sesi
/// (kendi WebView'umuzdan çıkan) yakalanmaz — echo olmaz.
///
/// Veri akışı:
/// ```text
/// WASAPI capture (f32 48kHz stereo)
///   → f32→i16 dönüşüm (Rust)
///   → Tauri IPC event ("audio-pcm")
///   → Frontend AudioWorklet (pcm-worklet-processor.js)
///   → MediaStreamTrack
///   → LiveKit publishTrack(track, { source: ScreenShareAudio })
/// ```
///
/// Neden f32 capture + i16 dönüşüm?
/// WASAPI shared mode doğal olarak f32 (IEEE Float) kullanır. autoconvert ile i16
/// isteyebiliriz ama dönüşümü kendimiz yapmak daha güvenilir ve kontrol sağlar.
///
/// Chunk boyutu: 20ms = 960 frame × 2 kanal = 1920 i16 sample = 3840 byte
/// IPC hızı: ~50 event/saniye — Tauri local IPC için sorunsuz (~192KB/s)
///
/// Platform desteği:
/// - Windows 10 Build 20348+: Tam destek (WASAPI per-process loopback)
/// - Eski Windows / macOS / Linux: start() hata döner, uygulama sessizce devam eder

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::AppHandle;

/// Tauri IPC event'i ile gönderilen PCM ses chunk'ı.
///
/// Frontend bu payload'u `listen("audio-pcm")` ile alır ve AudioWorklet'e iletir.
/// Samples: interleaved stereo i16 — [L, R, L, R, ...]
/// Her chunk 20ms ses verisi içerir (960 frame × 2 kanal = 1920 sample).
#[derive(Clone, serde::Serialize)]
pub struct PcmChunk {
    /// Interleaved stereo i16 PCM samples.
    /// Uzunluk: 1920 (960 frame × 2 kanal)
    /// Değer aralığı: [-32767, 32767]
    pub samples: Vec<i16>,
}

/// WASAPI per-process audio capture controller.
///
/// `start()` bir background thread başlatır, `stop()` ile durdurulur.
/// Thread-safe: `AtomicBool` ile start/stop senkronize edilir.
///
/// Yaşam döngüsü:
/// 1. `new()` → Controller oluştur (henüz capture yok)
/// 2. `start(app)` → Background thread başlat, PCM event'leri yayınla
/// 3. `stop()` → Flag'i false yap, thread temiz kapansın
/// 4. Thread otomatik olarak flag'i false yapar (hata veya normal kapanış)
pub struct AudioCapture {
    /// Background capture thread'in çalışma durumu.
    /// true = çalışıyor, false = dur sinyali verildi veya durdu.
    /// SeqCst ordering: tüm thread'lerde tutarlı görünürlük.
    running: Arc<AtomicBool>,
}

impl AudioCapture {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Capture'ın şu an çalışıp çalışmadığını kontrol eder.
    #[allow(dead_code)]
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Background thread'deki capture loop'u durdurur.
    ///
    /// AtomicBool flag false yapılır → capture thread bir sonraki
    /// iterasyonda flag'i kontrol edip temiz bir şekilde çıkar.
    /// Thread join yapmaz — fire-and-forget. Thread kendi kendine kapanır.
    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    /// WASAPI per-process audio capture başlatır.
    ///
    /// Background thread'de çalışır:
    /// 1. COM init (MTA — WASAPI gerektirir)
    /// 2. AudioClient oluştur (EXCLUDE mode, kendi PID'imiz)
    /// 3. 48kHz stereo f32 capture → i16 dönüşüm → IPC emit
    ///
    /// Hata durumları:
    /// - Zaten çalışıyorsa: "Audio capture already running"
    /// - Windows dışı platform: "Per-process audio capture is only supported on Windows"
    /// - WASAPI hatası (eski Windows, cihaz yok): thread log'layıp kapanır
    #[cfg(windows)]
    pub fn start(&self, app: AppHandle) -> Result<(), String> {
        // Çift başlatma koruması
        if self.running.load(Ordering::SeqCst) {
            return Err("Audio capture already running".into());
        }

        self.running.store(true, Ordering::SeqCst);
        let running = self.running.clone();

        // Background thread: WASAPI capture loop
        // AudioCaptureClient !Send ve !Sync olduğu için tüm WASAPI işlemleri
        // bu thread içinde kalmalı. Sadece AtomicBool (running) ve AppHandle
        // (Send + Sync) thread'ler arası paylaşılır.
        std::thread::spawn(move || {
            if let Err(e) = capture_loop(app, running.clone()) {
                eprintln!("[AudioCapture] Capture loop error: {}", e);
            }
            // Thread bittiğinde flag'i temizle — is_running() false dönecek
            running.store(false, Ordering::SeqCst);
        });

        Ok(())
    }

    /// Non-Windows: per-process audio capture desteklenmiyor.
    /// Frontend bu hatayı alınca sessizce devam eder (sadece video paylaşılır).
    #[cfg(not(windows))]
    pub fn start(&self, _app: AppHandle) -> Result<(), String> {
        Err("Per-process audio capture is only supported on Windows".into())
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Windows-only: WASAPI capture loop implementation
// ═══════════════════════════════════════════════════════════════════════

/// Ana capture döngüsü — background thread'de çalışır.
///
/// WASAPI event-driven model:
/// 1. Event bekle (WASAPI yeni buffer hazır olduğunda sinyal verir)
/// 2. Tüm mevcut paketleri oku (VecDeque'ye biriktir)
/// 3. 20ms'lik chunk'lara böl
/// 4. f32 → i16 dönüşümü yap
/// 5. Tauri IPC event ile frontend'e gönder
/// 6. running flag false olana kadar tekrarla
#[cfg(windows)]
fn capture_loop(app: AppHandle, running: Arc<AtomicBool>) -> Result<(), String> {
    use std::collections::VecDeque;
    use tauri::Emitter;
    use wasapi::*;

    // ─── 1. COM Başlat ───
    // WASAPI, COM (Component Object Model) üzerine kurulu bir Windows API'si.
    // Her thread'de COM'un başlatılması gerekir.
    // MTA = Multi-Threaded Apartment: birden fazla thread aynı COM nesnelerine
    // erişebilir. UI thread'lerde STA kullanılır, background'da MTA tercih edilir.
    // initialize_mta() → CoInitializeEx(None, COINIT_MULTITHREADED) çağırır.
    // Dönüş tipi HRESULT — .ok() ile Result'a çevrilir.
    initialize_mta()
        .ok()
        .map_err(|e| format!("COM initialization failed: {}", e))?;

    // ─── 2. Kendi PID'imizi al ───
    // EXCLUDE mode'da bu PID'e ait process tree'nin tüm ses çıkışı
    // yakalama dışında bırakılır. Tauri uygulaması tek process tree'de çalışır
    // (ana process + WebView child process'leri), dolayısıyla WebView'den
    // çıkan voice chat sesi capture'a girmez.
    let pid = std::process::id();

    // ─── 3. Application Loopback Client Oluştur ───
    // new_application_loopback_client: Windows 10 Build 20348+ API'si.
    // Dahili olarak ActivateAudioInterfaceAsync + VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
    // kullanır.
    //
    // include_tree parametresi:
    //   true  → INCLUDE mode: sadece hedef process tree'nin sesini yakala
    //   false → EXCLUDE mode: hedef process tree HARİÇ tüm sistem sesini yakala
    //
    // Biz false (EXCLUDE) kullanıyoruz: "Benim uygulamamın sesi HARİÇ, her şeyi yakala"
    // → Oyun sesi, müzik, diğer uygulamalar yakalanır
    // → Voice chat sesi (kendi WebView'umuz) yakalanMAZ
    let mut audio_client = AudioClient::new_application_loopback_client(pid, false)
        .map_err(|e| format!("Failed to create loopback client: {}", e))?;

    // ─── 4. Wave Format Tanımla ───
    // WASAPI shared mode doğal olarak f32 (IEEE 754 Float) kullanır.
    // Biz de f32 olarak capture edip, IPC öncesinde i16'ya dönüştüreceğiz.
    //
    // WaveFormat parametreleri:
    //   storebits: 32    — her sample 4 byte depolama
    //   validbits: 32    — 32 bit'in tamamı geçerli
    //   SampleType::Float — IEEE 754 float format
    //   48000            — WebRTC/LiveKit standart sample rate
    //   2                — stereo (sol + sağ kanal)
    //   None             — channel mask otomatik (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT)
    let desired_format = WaveFormat::new(32, 32, &SampleType::Float, 48000, 2, None);

    // blockalign: bir frame'in byte boyutu = channels × bytes_per_sample
    // f32 stereo: 2 kanal × 4 byte = 8 byte/frame
    let blockalign = desired_format.get_blockalign() as usize;

    // ─── 5. Stream Mode Ayarla ───
    // EventsShared: Event-driven capture modu.
    // WASAPI yeni buffer hazır olduğunda Windows Event nesnesi sinyal eder,
    // biz wait_for_event() ile bekleriz. Polling'e göre çok daha CPU dostu —
    // boş döngü yapmaz, thread sleep durumunda kalır.
    //
    // autoconvert: true
    //   WASAPI audio engine, cihazın gerçek formatı (genellikle f32 44.1/48kHz)
    //   ile bizim istediğimiz format arasında otomatik dönüşüm yapar.
    //   Bu sayede cihaz formatı ne olursa olsun bize 48kHz f32 stereo gelir.
    //
    // buffer_duration_hns: 0
    //   Application loopback client'lar için bu değer anlamsız — WASAPI
    //   buffer boyutunu kendisi belirler. Dokümantasyon: "use 0".
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };

    // ─── 6. Client'ı Başlat ───
    // Direction::Capture: Ses yakalama modu (Render = ses çalma)
    // Application loopback için MUTLAKA Capture kullanılmalı —
    // Render kullanmak RenderToCaptureDevice hatası verir.
    audio_client
        .initialize_client(&desired_format, &Direction::Capture, &mode)
        .map_err(|e| format!("Client initialization failed: {}", e))?;

    // ─── 7. Event Handle Al ───
    // set_get_eventhandle(): Windows Event nesnesi oluşturur ve WASAPI'ye kaydeder.
    // WASAPI yeni buffer hazır olduğunda bu handle'ı SignalEvent ile sinyal eder.
    // wait_for_event(ms): WaitForSingleObject ile bloklar — CPU kullanmaz.
    // Handle Drop trait implemente eder — scope dışına çıkınca otomatik kapanır.
    let h_event = audio_client
        .set_get_eventhandle()
        .map_err(|e| format!("Failed to get event handle: {}", e))?;

    // ─── 8. Capture Alt-Client Al ───
    // AudioCaptureClient: IAudioCaptureClient wrapper'ı.
    // Buffer'dan ses verisi okumak için kullanılır.
    //
    // ÖNEMLİ: !Send ve !Sync trait'leri implemente ETMEZ.
    // Sadece oluşturulduğu thread'de kullanılabilir — bu yüzden tüm
    // WASAPI işlemleri tek thread'de (bu background thread) yapılır.
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| format!("Failed to get capture client: {}", e))?;

    // ─── 9. Buffer Hazırla ───
    // VecDeque<u8>: çift taraflı kuyruk (double-ended queue).
    // Arkadan ekleme (push_back via read_from_device_to_deque) ve
    // önden çıkarma (drain) O(1) amortize.
    //
    // Neden Vec değil VecDeque?
    // Vec ile önden eleman çıkarmak O(n) (tüm elemanlar kaydırılır).
    // VecDeque ring buffer — head/tail pointer'ları ile O(1) drain.
    // Ses verisi sürekli arkadan eklenir, önden chunk'lar halinde çıkarılır
    // → VecDeque ideal veri yapısı.
    let mut sample_queue: VecDeque<u8> = VecDeque::new();

    // 20ms chunk boyutu hesaplama:
    // 48000 Hz × 0.020 s = 960 frame (20ms'lik ses)
    // 960 frame × 8 byte/frame (f32 stereo) = 7680 byte
    // Dönüşüm sonrası: 960 frame × 4 byte/frame (i16 stereo) = 3840 byte = 1920 i16
    let chunk_frames: usize = 960;
    let chunk_bytes = chunk_frames * blockalign;

    // ─── 10. Stream Başlat ───
    // start_stream(): WASAPI capture'ı aktif eder.
    // Bu noktadan itibaren sistem sesi buffer'a akmaya başlar.
    audio_client
        .start_stream()
        .map_err(|e| format!("Failed to start audio stream: {}", e))?;

    // ─── 11. Capture Loop ───
    // Ana döngü: Event bekle → buffer oku → chunk'la → dönüştür → IPC emit
    //
    // Döngü şu durumlarda biter:
    // - running flag false (stop() çağrıldı)
    // - WASAPI okuma hatası (cihaz kayboldu vb.)
    // - IPC emit hatası (window kapandı, listener yok)
    while running.load(Ordering::SeqCst) {
        // 11a. Event bekle (100ms timeout)
        // Kısa timeout sayesinde running flag kontrolü responsive olur.
        // stop() çağrıldıktan sonra en fazla 100ms içinde döngü biter.
        // Timeout: hedef process ses üretmiyor demek — döngü başına dön.
        if h_event.wait_for_event(100).is_err() {
            continue;
        }

        // 11b. Mevcut tüm paketleri oku
        // WASAPI birden fazla paket biriktirmiş olabilir — hepsini drain et.
        // get_next_packet_size(): sonraki paketin frame sayısı.
        // None veya Some(0) = veri yok, iç döngüden çık.
        loop {
            match capture_client.get_next_packet_size() {
                Ok(Some(0)) | Ok(None) => break,
                Ok(Some(_frames)) => {
                    // read_from_device_to_deque: paketin tüm byte'larını VecDeque'ye ekler.
                    // Dahili olarak IAudioCaptureClient::GetBuffer + ReleaseBuffer çağırır.
                    // Değişken uzunluklu okuma — VecDeque dinamik büyür.
                    if let Err(e) = capture_client.read_from_device_to_deque(&mut sample_queue) {
                        eprintln!("[AudioCapture] Buffer read error: {}", e);
                        break;
                    }
                }
                Err(e) => {
                    // Kritik hata — capture devam edemez
                    eprintln!("[AudioCapture] Packet size query failed: {}", e);
                    running.store(false, Ordering::SeqCst);
                    break;
                }
            }
        }

        // 11c. Biriken verileri 20ms chunk'lara böl ve IPC ile gönder
        // chunk_bytes (7680) kadar veri biriktiyse: çıkar, dönüştür, emit et.
        // Birden fazla chunk birikmiş olabilir — while ile hepsini gönder.
        while sample_queue.len() >= chunk_bytes {
            // VecDeque drain: ilk chunk_bytes byte'ı çıkar
            // drain(..n): O(n) — pop_front döngüsünden daha verimli,
            // tek seferde range çıkarır.
            let chunk: Vec<u8> = sample_queue.drain(..chunk_bytes).collect();

            // f32 PCM → i16 PCM dönüşümü
            // Her 4 byte (f32) → 1 i16 sample
            // 7680 byte → 1920 i16 sample (960 frame × 2 kanal)
            let i16_samples = f32_bytes_to_i16(&chunk);

            // Tauri IPC event: "audio-pcm"
            // Frontend listen("audio-pcm", callback) ile alır.
            // PcmChunk { samples } serde ile JSON'a serialize edilir.
            if app
                .emit("audio-pcm", PcmChunk { samples: i16_samples })
                .is_err()
            {
                // emit hatası: tüm window'lar kapandı veya app shutdown
                running.store(false, Ordering::SeqCst);
                break;
            }
        }
    }

    // ─── 12. Temiz Kapanış ───
    // stop_stream(): WASAPI capture'ı durdurur, buffer'ları temizler.
    // Hata yutulur — zaten kapatıyoruz, hata loglamak anlamsız.
    let _ = audio_client.stop_stream();

    Ok(())
}

/// f32 PCM byte dizisini i16 sample dizisine dönüştürür.
///
/// WASAPI f32 formatında [-1.0, 1.0] aralığında sample verir (teorik).
/// Pratikte bazı ses kaynakları bu aralığı aşabilir — clamp ile sınırlarız.
///
/// Dönüşüm formülü: i16_sample = clamp(f32_sample, -1.0, 1.0) × 32767
/// i16 aralığı: [-32768, 32767], biz 32767 kullanarak simetrik tutuyoruz.
///
/// Byte order: Little-endian (Windows her zaman LE kullanır).
/// Her 4 byte = 1 f32 sample → 1 i16 sample.
#[cfg(windows)]
fn f32_bytes_to_i16(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(4)
        .map(|chunk| {
            let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            let clamped = sample.clamp(-1.0, 1.0);
            (clamped * 32767.0) as i16
        })
        .collect()
}
