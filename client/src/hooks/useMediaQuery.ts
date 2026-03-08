/**
 * useMediaQuery — Reactive CSS media query hook.
 *
 * Uses window.matchMedia() — only re-renders on breakpoint transitions.
 * SSR-safe: returns false if window is undefined.
 */

import { useEffect, useState } from "react";

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mql = window.matchMedia(query);

    // Sync on mount in case of SSR hydration mismatch
    setMatches(mql.matches);

    function handleChange(e: MediaQueryListEvent) {
      setMatches(e.matches);
    }

    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, [query]);

  return matches;
}

/** Phone + small tablet portrait */
function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 768px)");
}

/** Tablet landscape (includes 768px) */
function useIsTablet(): boolean {
  return useMediaQuery("(max-width: 1024px)");
}

export { useMediaQuery, useIsMobile, useIsTablet };
