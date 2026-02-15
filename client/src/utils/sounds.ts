/**
 * sounds.ts — Kanal giriş/çıkış ses efektleri.
 *
 * Web Audio API ile runtime'da sentezlenen kısa sesler kullanılır.
 * Fiziksel ses dosyası (mp3) yerine bu yaklaşım:
 * - Ek dosya yönetimi gerektirmez
 * - Bundle boyutunu artırmaz
 * - Her zaman çalışır (dosya 404 riski yok)
 *
 * Join sesi: Yükselen ton (200Hz → 500Hz, 0.15s) — pozitif, "bloop" hissi
 * Leave sesi: Düşen ton (400Hz → 200Hz, 0.12s) — negatif, "pop-down" hissi
 *
 * Volume: voiceStore.masterVolume ayarına bağlıdır.
 * Tüm sesler GainNode ile volume kontrol edilir.
 */

import { useVoiceStore } from "../stores/voiceStore";

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
 */
function playTone(
  startFreq: number,
  endFreq: number,
  duration: number,
  volume: number
): void {
  try {
    const ctx = getAudioContext();

    // Suspended context'i resume et (Chrome autoplay policy)
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;

    // Oscillator: sinüs dalgası — en temiz, tıkırtısız ses
    const osc = ctx.createOscillator();
    osc.type = "sine";
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
