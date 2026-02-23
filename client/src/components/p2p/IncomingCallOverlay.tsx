/**
 * IncomingCallOverlay — Gelen arama bildirimi overlay'ı.
 *
 * AppLayout seviyesinde her zaman mount edilir.
 * p2pCallStore.incomingCall !== null ise görünür.
 *
 * Gösterir:
 * - Arayan kişinin avatar + isim + arama tipi (sesli/görüntülü)
 * - Kabul (yeşil) ve Reddet (kırmızı) butonları
 * - 30sn timeout → otomatik decline (useP2PCall hook'unda yönetilir)
 * - CSS pulse animasyonu + ringtone (Web Audio API)
 *
 * CSS: .ico-overlay, .ico-card, .ico-avatar-wrap, .ico-info,
 *       .ico-actions, .ico-btn-accept, .ico-btn-decline
 */

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useP2PCallStore } from "../../stores/p2pCallStore";
import { useAuthStore } from "../../stores/authStore";
import Avatar from "../shared/Avatar";

/**
 * playRingtone — Gelen arama sesi çalar (Web Audio API).
 *
 * OscillatorNode ile sinüs dalgası üretir — mp3 dosyası gerekmez.
 * Mevcut synth sounds pattern'i (join/leave ses) ile aynı yaklaşım.
 *
 * Pattern: 440Hz + 554Hz birlikte, 1s çal / 1s sus, tekrarla.
 *
 * @returns stop fonksiyonu — overlay kapanınca çağrılır
 */
/**
 * playRingtone — Gelen arama sesi çalar (Web Audio API).
 *
 * Chrome autoplay policy:
 * AudioContext kullanıcı etkileşimi olmadan oluşturulursa "suspended" durumda başlar.
 * ctx.resume() ile "running" durumuna geçirilir — kullanıcı sayfayla en az bir kez
 * etkileşime girdiyse (tıklama, tuş basma vb.) resume başarılı olur.
 * Hiç etkileşim olmadıysa resume promise bekler, ilk etkileşimde otomatik çözülür.
 *
 * @returns stop fonksiyonu — overlay kapanınca çağrılır
 */
async function playRingtone(): Promise<() => void> {
  try {
    const ctx = new AudioContext();

    // Suspended ise resume et — Chrome autoplay policy gereği
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const gainNode = ctx.createGain();
    gainNode.gain.value = 0.15;
    gainNode.connect(ctx.destination);

    let isPlaying = true;
    let osc1: OscillatorNode | null = null;
    let osc2: OscillatorNode | null = null;
    let timeout: ReturnType<typeof setTimeout>;

    function ring() {
      if (!isPlaying) return;

      osc1 = ctx.createOscillator();
      osc2 = ctx.createOscillator();
      osc1.frequency.value = 440;
      osc2.frequency.value = 554;
      osc1.connect(gainNode);
      osc2.connect(gainNode);
      osc1.start();
      osc2.start();

      // 1s çal, 1s sus
      timeout = setTimeout(() => {
        osc1?.stop();
        osc2?.stop();
        timeout = setTimeout(ring, 1000);
      }, 1000);
    }

    ring();

    return () => {
      isPlaying = false;
      clearTimeout(timeout);
      osc1?.stop();
      osc2?.stop();
      ctx.close();
    };
  } catch {
    return () => {};
  }
}

function IncomingCallOverlay() {
  const { t } = useTranslation("common");
  const incomingCall = useP2PCallStore((s) => s.incomingCall);
  const acceptCall = useP2PCallStore((s) => s.acceptCall);
  const declineCall = useP2PCallStore((s) => s.declineCall);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const stopRingtoneRef = useRef<(() => void) | null>(null);

  // Ringtone: gelen arama olduğunda çal, kapanınca durdur.
  // playRingtone async olduğu için .then ile stop fonksiyonunu kaydediyoruz.
  // Cleanup sırasında "cancelled" flag ile race condition'ı önlüyoruz —
  // unmount sonrası resolve olan promise'in stale ref'e yazmasını engeller.
  useEffect(() => {
    let cancelled = false;

    if (incomingCall) {
      playRingtone().then((stop) => {
        if (cancelled) {
          stop();
        } else {
          stopRingtoneRef.current = stop;
        }
      });
    }

    return () => {
      cancelled = true;
      if (stopRingtoneRef.current) {
        stopRingtoneRef.current();
        stopRingtoneRef.current = null;
      }
    };
  }, [incomingCall]);

  if (!incomingCall || !currentUserId) return null;

  // Sadece receiver'a göster — caller kendi başlattığı aramayı overlay'da görmez
  if (incomingCall.caller_id === currentUserId) return null;

  const callerName = incomingCall.caller_display_name ?? incomingCall.caller_username;
  const isVideo = incomingCall.call_type === "video";

  function handleAccept() {
    acceptCall(incomingCall!.id);
  }

  function handleDecline() {
    declineCall(incomingCall!.id);
  }

  return (
    <div className="ico-overlay">
      <div className="ico-card">
        {/* Avatar + bilgi */}
        <div className="ico-avatar-wrap">
          <Avatar
            name={callerName}
            avatarUrl={incomingCall.caller_avatar ?? undefined}
            size={72}
            isCircle
          />
          {/* Pulse ring animasyonu */}
          <div className="ico-pulse-ring" />
        </div>

        <div className="ico-info">
          <span className="ico-caller-name">{callerName}</span>
          <span className="ico-call-type">
            {isVideo ? t("incomingVideoCall") : t("incomingCall")}
          </span>
        </div>

        {/* Kabul / Reddet butonları */}
        <div className="ico-actions">
          <button className="ico-btn ico-btn-decline" onClick={handleDecline} title={t("declineCall")}>
            {/* Phone down SVG */}
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 0 1-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85a1 1 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
            </svg>
          </button>
          <button className="ico-btn ico-btn-accept" onClick={handleAccept} title={t("acceptCall")}>
            {/* Phone up SVG */}
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 0 0-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

export default IncomingCallOverlay;
