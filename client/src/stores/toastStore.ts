/**
 * Toast Store — Zustand ile global toast notification yönetimi.
 *
 * Toast sistemi neden Zustand store?
 * - Herhangi bir component veya non-React koddan erişilebilir olmalı
 *   (useToastStore.getState().addToast(...) ile)
 * - Global state — aynı anda birden fazla toast gösterilebilir
 * - Auto-dismiss timer'ları merkezi yönetim gerektirir
 *
 * Timer yönetimi neden state dışında (module-level Map)?
 * - setTimeout ID'leri serialize edilemez (Zustand devtools uyumsuz)
 * - Timer'lar state değişikliği değil, side effect — state'te tutmak
 *   gereksiz re-render tetikler
 * - Module-level Map ile timer oluştur/iptal yönetimi izole kalır
 */

import { create } from "zustand";

/** Toast görsel tipi — sol kenar rengi ve ikonu belirler */
type ToastType = "success" | "error" | "warning" | "info";

/** Tek bir toast notification */
type Toast = {
  /** Benzersiz ID — crypto.randomUUID() ile üretilir */
  id: string;
  /** Görsel tip — success/error/warning/info */
  type: ToastType;
  /** Gösterilecek mesaj — i18n çevrilmiş string */
  message: string;
  /** Otomatik kapanma süresi (ms) */
  duration: number;
  /** Kapanma animasyonu aktif mi? */
  isExiting: boolean;
};

type ToastState = {
  toasts: Toast[];

  /**
   * addToast — Yeni toast ekler ve auto-dismiss timer başlatır.
   *
   * @param type - Toast tipi (success/error/warning/info)
   * @param message - Gösterilecek mesaj (çevrilmiş)
   * @param duration - Otomatik kapanma süresi ms (varsayılan 4000)
   */
  addToast: (type: ToastType, message: string, duration?: number) => void;

  /**
   * removeToast — Toast'ı exit animasyonu ile kaldırır.
   * Önce isExiting=true yapılır (fade-out), 300ms sonra state'ten silinir.
   */
  removeToast: (id: string) => void;
};

/** Auto-dismiss timer ID'leri — state dışında tutulur (serialization uyumsuzluğu) */
const timerMap = new Map<string, ReturnType<typeof setTimeout>>();

/** Aynı anda gösterilebilecek maksimum toast sayısı */
const MAX_VISIBLE = 5;

/** Varsayılan auto-dismiss süresi (ms) */
const DEFAULT_DURATION = 4000;

/** Exit animasyonu süresi (ms) — CSS transition süresiyle eşleşmeli */
const EXIT_ANIMATION_MS = 300;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  addToast: (type, message, duration = DEFAULT_DURATION) => {
    const id = crypto.randomUUID();

    const toast: Toast = {
      id,
      type,
      message,
      duration,
      isExiting: false,
    };

    set((state) => {
      // Max toast limitini aş → en eski toast'ları çıkar
      const updatedToasts = [...state.toasts, toast];
      if (updatedToasts.length > MAX_VISIBLE) {
        // Fazla toast'ların timer'larını temizle
        const removed = updatedToasts.splice(0, updatedToasts.length - MAX_VISIBLE);
        for (const r of removed) {
          const timerId = timerMap.get(r.id);
          if (timerId) {
            clearTimeout(timerId);
            timerMap.delete(r.id);
          }
        }
      }
      return { toasts: updatedToasts };
    });

    // Auto-dismiss timer başlat
    const timerId = setTimeout(() => {
      get().removeToast(id);
    }, duration);

    timerMap.set(id, timerId);
  },

  removeToast: (id) => {
    // Timer'ı iptal et (manuel kapatma durumunda)
    const timerId = timerMap.get(id);
    if (timerId) {
      clearTimeout(timerId);
      timerMap.delete(id);
    }

    // Exit animasyonu başlat — isExiting=true
    set((state) => ({
      toasts: state.toasts.map((t) =>
        t.id === id ? { ...t, isExiting: true } : t
      ),
    }));

    // Animasyon bitince state'ten tamamen sil
    setTimeout(() => {
      set((state) => ({
        toasts: state.toasts.filter((t) => t.id !== id),
      }));
    }, EXIT_ANIMATION_MS);
  },
}));
