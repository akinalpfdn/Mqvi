/**
 * useMediaQuery — Reactive CSS media query hook.
 *
 * `window.matchMedia()` API'sini kullanır — resize event'i yerine
 * sadece breakpoint eşiklerinde re-render tetiklenir (performans).
 *
 * Convenience wrapper'lar:
 * - useIsMobile() → max-width: 768px
 * - useIsTablet() → max-width: 1024px (768px dahil)
 *
 * SSR-safe: window yoksa false döner.
 */

import { useEffect, useState } from "react";

/**
 * useMediaQuery — Verilen CSS media query'sinin eşleşip eşleşmediğini
 * reactive olarak döner.
 *
 * @param query CSS media query string'i (örn: "(max-width: 768px)")
 * @returns Eşleşme durumu (boolean)
 *
 * Nasıl çalışır:
 * 1. İlk render'da `window.matchMedia(query).matches` ile senkron kontrol
 * 2. `change` event listener ile threshold geçişlerinde state güncelleme
 * 3. Component unmount'ta listener temizlenir
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mql = window.matchMedia(query);

    // İlk mount'ta mismatch olabilir (SSR hydration), senkronize et
    setMatches(mql.matches);

    function handleChange(e: MediaQueryListEvent) {
      setMatches(e.matches);
    }

    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}

/** 768px altı — telefon + küçük tablet portrait */
function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 768px)");
}

/** 1024px altı — tablet landscape dahil (768px de dahil) */
function useIsTablet(): boolean {
  return useMediaQuery("(max-width: 1024px)");
}

export { useMediaQuery, useIsMobile, useIsTablet };
