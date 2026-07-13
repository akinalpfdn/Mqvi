import { useEffect, useRef } from "react";
import { pushBackHandler } from "../utils/backStack";

/**
 * Closes this layer when the Android back button is pressed, for as long as it is mounted
 * and `enabled`. Pass `enabled` when the component stays mounted while hidden — a handler
 * registered by an invisible layer would swallow the gesture and the app could never be
 * backed out of. No-op on desktop and web, where nothing dispatches the back gesture.
 */
export function useBackHandler(onBack: () => void, enabled = true): void {
  const latest = useRef(onBack);
  latest.current = onBack;

  useEffect(() => {
    if (!enabled) return;
    return pushBackHandler(() => latest.current());
  }, [enabled]);
}
