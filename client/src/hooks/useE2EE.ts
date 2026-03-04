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

/**
 * useE2EE — E2EE baslangic ve WS event entegrasyonu.
 *
 * AppLayout'ta bir kez cagrilir. Kullanicinin userId'si
 * ile e2eeStore.initialize() tetiklenir.
 */
export function useE2EE(): void {
  const userId = useAuthStore((s) => s.user?.id);
  const initialize = useE2EEStore((s) => s.initialize);

  /**
   * initCalledRef — StrictMode'da cift cagrimi onler.
   * React StrictMode development'ta useEffect'i iki kez cagirabilir.
   * Bu ref ile sadece ilk cagriyi isliyoruz.
   *
   * userId degistiginde (logout → login) ref sifirlanir.
   */
  const initCalledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) {
      // Kullanici logout yapmis — ref sifirla
      initCalledRef.current = null;
      return;
    }

    // Ayni userId icin tekrar initialize etme
    if (initCalledRef.current === userId) return;

    initCalledRef.current = userId;
    initialize(userId);
  }, [userId, initialize]);
}
