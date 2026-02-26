/**
 * sounds.ts — Kanal giriş/çıkış, yayın izleme ve mesaj bildirim ses efektleri.
 *
 * Web Audio API ile runtime'da sentezlenen kısa sesler kullanılır.
 * Fiziksel ses dosyası (mp3) yerine bu yaklaşım:
 * - Ek dosya yönetimi gerektirmez
 * - Bundle boyutunu artırmaz
 * - Her zaman çalışır (dosya 404 riski yok)
 *
 * Üç farklı ses ailesi — birbirinden ayırt edilebilir olması için
 * farklı dalga tipi ve frekans aralığı kullanır:
 *
 * Voice (sine wave, 200-600Hz — yumuşak, organik):
 *   Join:  Yükselen ton 350Hz → 600Hz, 0.15s — pozitif "bloop"
 *   Leave: Düşen ton 400Hz → 200Hz, 0.12s — "pop-down"
 *
 * Watch (triangle wave, 320-620Hz — kalın, hafif dijital):
 *   Start: Çift yükselen pop 380→500Hz + 500→620Hz, triangle — "bip-bip"
 *   Stop:  Düşen ton 480→320Hz, triangle — "pop-down" (leave'den farklı tını)
 *
 * Notification (sine wave, 800-1000Hz — kısa, hafif "ding"):
 *   Mesaj/DM/Reaction bildirimi. Çift kısa sine pop: 800→900Hz + 900→1000Hz.
 *   Voice seslerinden (200-600Hz) daha yüksek frekans → bildirimlere özgü tını.
 *   DND modunda çalmaz.
 *
 * Volume: voiceStore.masterVolume ayarına bağlıdır.
 * Tüm sesler GainNode ile volume kontrol edilir.
 */

import { useVoiceStore } from "../stores/voiceStore";
import { useAuthStore } from "../stores/authStore";

/**
 * Lazily initialized AudioContext.
 *
 * Web Audio API'da AudioContext oluşturmak pahalıdır — sadece ilk ses
 * çalınırken oluşturulur. Ayrıca bazı tarayıcılar (Chrome) user gesture
 * olmadan AudioContext oluşturmayı engelleyebilir — bu yüzden ilk ses
 * çalımında context.resume() çağrılır.
 */
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  return audioCtx;
}

/**
 * playTone — Web Audio API ile kısa bir ton çalar.
 *
 * OscillatorNode: Sinüs dalgası üretir (en yumuşak ses tipi)
 * GainNode: Volume kontrolü + fade-out (click/pop önleme)
 *
 * @param startFreq — Başlangıç frekansı (Hz)
 * @param endFreq — Bitiş frekansı (Hz) — frekans ramp'i ile geçiş
 * @param duration — Süre (saniye)
 * @param volume — Volume (0-1)
 * @param waveType — Dalga tipi (varsayılan "sine"). "triangle" daha dijital tını verir.
 */
function playTone(
  startFreq: number,
  endFreq: number,
  duration: number,
  volume: number,
  waveType: OscillatorType = "sine"
): void {
  try {
    const ctx = getAudioContext();

    // Suspended context'i resume et (Chrome autoplay policy)
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    // Oscillator: waveType ile dalga tipi seçilir
    // sine → yumuşak, organik (voice join/leave)
    // triangle → hafif keskin, dijital (watch start/stop)
    const osc = ctx.createOscillator();
    osc.type = waveType;
    osc.frequency.setValueAtTime(startFreq, now);
    osc.frequency.linearRampToValueAtTime(endFreq, now + duration);

    // GainNode: volume kontrolü + fade-out ile yumuşak bitiş
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume * 0.3, now);
    gain.gain.linearRampToValueAtTime(0, now + duration);

    // Audio graph: osc → gain → speakers
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + duration);
  } catch {
    // AudioContext desteklenmiyor veya hata — sessizce devam et
  }
}

/**
 * playJoinSound — Kanal giriş sesi.
 *
 * Yükselen ton: 350Hz → 600Hz, 0.15s süre.
 * Pozitif, hoş karşılama hissi veren kısa "bloop".
 */
export function playJoinSound(): void {
  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = masterVolume / 100;
  playTone(350, 600, 0.15, volume);
}

/**
 * playLeaveSound — Kanal çıkış sesi.
 *
 * Düşen ton: 400Hz → 200Hz, 0.12s süre.
 * Ayrılma hissi veren kısa "pop-down".
 */
export function playLeaveSound(): void {
  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = masterVolume / 100;
  playTone(400, 200, 0.12, volume);
}

/**
 * playWatchStartSound — Yayın izlemeye başlama sesi.
 *
 * Çift yükselen triangle pop: 380→500Hz ardından 500→620Hz.
 * Join sesinden (sine 350→600Hz tek pop) farklı:
 * - Triangle wave → daha dijital tını (sine'ın yumuşaklığı yok)
 * - Çift pop pattern → tek pop olan join'den ritm olarak farklı
 */
export function playWatchStartSound(): void {
  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = masterVolume / 100;
  playTone(380, 500, 0.08, volume, "triangle");
  // İkinci pop biraz gecikmeyle — çift "bip-bip" hissi
  setTimeout(() => playTone(500, 620, 0.08, volume, "triangle"), 90);
}

/**
 * playWatchStopSound — Yayın izlemeyi bırakma sesi.
 *
 * Triangle düşen ton: 480Hz → 320Hz, 0.1s.
 * Leave sesinden (sine 400→200Hz) farklı:
 * - Triangle wave → farklı tını
 * - Leave'in derin "pop-down"u yerine daha hafif bir "tık-down"
 */
export function playWatchStopSound(): void {
  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = masterVolume / 100;
  playTone(480, 320, 0.1, volume, "triangle");
}

/**
 * playNotificationSound — Mesaj / DM / Reaction bildirim sesi.
 *
 * Çift kısa sine pop: 800→900Hz ardından 900→1000Hz.
 * Voice seslerinden (200-600Hz) daha yüksek frekansta — bildirim tınısı.
 * Kısa süreli (toplam ~0.14s) ve düşük volume — rahatsız etmez.
 *
 * DND ve Invisible modunda çalmaz (kullanıcı rahatsız edilmek istemiyor).
 * soundsEnabled=false ise de çalmaz.
 */
export function playNotificationSound(): void {
  // DND veya Invisible modunda bildirim sesi çalma
  const manualStatus = useAuthStore.getState().manualStatus;
  if (manualStatus === "dnd" || manualStatus === "offline") return;

  const { soundsEnabled, masterVolume } = useVoiceStore.getState();
  if (!soundsEnabled) return;

  const volume = (masterVolume / 100) * 0.6; // Bildirim sesi biraz daha kısık
  playTone(800, 900, 0.06, volume);
  setTimeout(() => playTone(900, 1000, 0.06, volume), 70);
}
