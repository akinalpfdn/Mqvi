import { useEffect, useRef } from "react";
import { pushBackHandler } from "../utils/backStack";

/**
 * Closes this layer when the Android back button is pressed, for as long as it is mounted.
 * No-op on desktop and web, where nothing dispatches the back gesture.
 */
export function useBackHandler(onBack: () => void): void {
  const latest = useRef(onBack);
  latest.current = onBack;

  useEffect(() => pushBackHandler(() => latest.current()), []);
}
