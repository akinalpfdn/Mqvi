/**
 * Renews a lapsed file token when the app comes back — to the foreground or online — while signed
 * in. A phone resumed after a day, or a laptop woken from sleep, would otherwise request images
 * with an expired token until some API call happened to refresh it.
 */

import { useEffect } from "react";
import { ensureFreshFileToken } from "../api/client";
import { useAppFocusStore } from "../stores/appFocusStore";

export function useFileTokenFreshness(isSignedIn: boolean): void {
  useEffect(() => {
    if (!isSignedIn) return;

    const renew = () => void ensureFreshFileToken();
    renew();
    window.addEventListener("online", renew);
    const unsubscribe = useAppFocusStore.subscribe((state, prev) => {
      if (state.isForeground === true && prev.isForeground !== true) renew();
    });
    return () => {
      window.removeEventListener("online", renew);
      unsubscribe();
    };
  }, [isSignedIn]);
}
