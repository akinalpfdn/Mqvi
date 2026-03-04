/**
 * useE2EE — E2EE baslangic hook'u.
 *
 * AppLayout.tsx'de cagrilir — useWebSocket ve useVoice gibi
 * uygulama baslatildiginda bir kez calisir.
 *
 * Gorevleri:
 * 1. Kullanici giriş yapmissa e2eeStore.initialize() cagirir
 * 2. WS event'lerini dinler (prekey_low, device_list_update vb.)
 * 3. initStatus'a gore NewDeviceSetup modal'ini kontrol eder
 *
 * Not: Bu hook AppLayout icinde cagrilir,
 * yani sadece authenticate olmus kullanicilarda aktiftir.
 */

import { useEffect, useRef } from "react";
import { useAuthStore } from "../stores/authStore";
import { useE2EEStore } from "../stores/e2eeStore";

/** Maksimum otomatik yeniden deneme sayisi */
const MAX_RETRIES = 2;

/** Yeniden deneme arasi bekleme (ms) */
const RETRY_DELAY = 3000;

/**
 * useE2EE — E2EE baslangic ve WS event entegrasyonu.
 *
 * AppLayout'ta bir kez cagrilir. Kullanicinin userId'si
 * ile e2eeStore.initialize() tetiklenir.
 *
 * Hata durumunda MAX_RETRIES kadar otomatik yeniden dener
 * (RETRY_DELAY ms aralıkla). Retry limit aşılırsa durur.
 */
export function useE2EE(): void {
  const userId = useAuthStore((s) => s.user?.id);
  const initialize = useE2EEStore((s) => s.initialize);
  const initStatus = useE2EEStore((s) => s.initStatus);

  /**
   * initCalledRef — StrictMode'da cift cagrimi onler.
   * userId degistiginde (logout → login) ref sifirlanir.
   */
  const initCalledRef = useRef<string | null>(null);
  const retryCountRef = useRef(0);

  useEffect(() => {
    if (!userId) {
      // Kullanici logout yapmis — ref sifirla
      initCalledRef.current = null;
      retryCountRef.current = 0;
      return;
    }

    // Basarili init veya henuz tamamlanmamis — tekrar deneme
    if (initCalledRef.current === userId && initStatus !== "error") return;

    // Hata durumunda otomatik retry (limit dahilinde)
    if (initStatus === "error" && initCalledRef.current === userId) {
      if (retryCountRef.current >= MAX_RETRIES) return; // Limit asildi — dur

      retryCountRef.current += 1;
      const timer = setTimeout(() => {
        initCalledRef.current = null; // Ref sifirla — bir sonraki render'da tekrar denenecek
        // initStatus'u "error"dan "uninitialized"a çek ki initialize tekrar girebilsin
        useE2EEStore.setState({ initStatus: "uninitialized", initError: null });
      }, RETRY_DELAY);
      return () => clearTimeout(timer);
    }

    // Ilk cagri veya retry sonrasi yeniden deneme
    initCalledRef.current = userId;
    initialize(userId);
  }, [userId, initialize, initStatus]);
}
