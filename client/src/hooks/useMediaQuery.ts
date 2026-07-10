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

/**
 * Primary pointer is coarse — a real touch device, not a narrow desktop window.
 * Gates affordances that depend on the input method rather than the viewport: a soft
 * keyboard has no Shift+Enter, so those surfaces need an explicit submit button.
 */
function useIsTouch(): boolean {
  return useMediaQuery("(pointer: coarse)");
}

export { useMediaQuery, useIsMobile, useIsTablet, useIsTouch };
