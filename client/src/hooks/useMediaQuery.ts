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

/**
 * Phone + small tablet portrait — and a phone on its side.
 *
 * Width alone said a landscape phone was a desktop: 915px wide clears the 768px bar, so the app
 * laid three columns out on a 400px-tall screen. The second clause catches it: a coarse pointer
 * with almost no height is a phone lying down. A landscape tablet has ~768px of height and stays
 * on the desktop layout, which is the right one there; a mouse never reports a coarse pointer,
 * so a narrow desktop window is untouched.
 *
 * MUST stay in step with the `@media (max-width: 768px), (pointer: coarse) and (max-height: 500px)`
 * blocks in globals.css. If one moves without the other, the app renders the mobile layout with
 * desktop styles.
 */
function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 768px), (pointer: coarse) and (max-height: 500px)");
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
