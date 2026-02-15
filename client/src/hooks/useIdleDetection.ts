/**
 * useIdleDetection — Kullanıcı inaktiflik algılama hook'u.
 *
 * Nasıl çalışır?
 * 1. Mouse hareketi, klavye vuruşu gibi DOM event'lerini dinler.
 * 2. IDLE_TIMEOUT (5dk) boyunca hiçbir event tetiklenmezse "idle" durumuna geçer.
 * 3. Tekrar aktivite algılandığında "online" durumuna döner.
 *
 * sendPresenceUpdate fonksiyonu useWebSocket hook'undan gelir.
 * Bu hook sadece "idle" ↔ "online" geçişlerinde WS event gönderir —
 * gereksiz tekrarlı mesaj göndermez.
 *
 * Throttle: Aktivite event'leri çok sık tetiklenir (özellikle mousemove).
 * Her event'te timer sıfırlamak pahalı olmasa da, status zaten "online" iken
 * tekrar sendPresenceUpdate göndermemek önemlidir.
 *
 * Bu hook AppLayout'ta bir kez çağrılır (singleton pattern —
 * useWebSocket ile aynı yaklaşım).
 */

import { useEffect, useRef } from "react";
import { IDLE_TIMEOUT, ACTIVITY_EVENTS } from "../utils/constants";
import type { UserStatus } from "../types";

type UseIdleDetectionParams = {
  /** WS üzerinden presence durumu gönderen fonksiyon */
  sendPresenceUpdate: (status: UserStatus) => void;
};

export function useIdleDetection({ sendPresenceUpdate }: UseIdleDetectionParams) {
  /**
   * isIdle — kullanıcının şu an idle durumunda olup olmadığını takip eder.
   *
   * Neden useState yerine useRef?
   * Bu değer yalnızca event handler'lar içinde okunur/yazılır,
   * React render'ı tetiklemesine gerek yoktur. useRef, closure'lar
   * arasında paylaşılan mutable değer için idealdir.
   */
  const isIdleRef = useRef(false);

  /** Idle timer ID'si — aktivite algılandığında sıfırlanır */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    /**
     * resetTimer — Her aktivitede çağrılır.
     *
     * 1. Mevcut timer'ı iptal eder (henüz idle olmadıysa yeniden başlat).
     * 2. Eğer kullanıcı idle durumdaysa → "online" gönder.
     * 3. Yeni IDLE_TIMEOUT timer'ı başlatır.
     */
    function resetTimer() {
      // Mevcut timer'ı temizle
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      // Eğer idle durumundayken aktivite algılandıysa → online'a dön
      if (isIdleRef.current) {
        isIdleRef.current = false;
        sendPresenceUpdate("online");
      }

      // Yeni idle timer başlat
      timerRef.current = setTimeout(() => {
        isIdleRef.current = true;
        sendPresenceUpdate("idle");
      }, IDLE_TIMEOUT);
    }

    // DOM event listener'larını kaydet
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, resetTimer, { passive: true });
    }

    // İlk timer'ı başlat (sayfa yüklendiğinde)
    resetTimer();

    // Cleanup: component unmount olduğunda event listener'ları kaldır
    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, resetTimer);
      }
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [sendPresenceUpdate]);
}
