/**
 * Cinema mode — the stream fills the screen and the phone turns sideways.
 *
 * Not the Fullscreen API: in a WebView there is no browser chrome to hide, so its only benefit
 * is gone, and it cannot be entered without a user gesture. A fixed, full-viewport element does
 * the same job with none of the rules. The rotation is the part that actually needs native
 * help — see utils/orientation.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { App } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import { isCapacitor } from "../utils/constants";
import { enterLandscape, restoreOrientation } from "../utils/orientation";

export function useCinemaMode(ref: RefObject<HTMLElement | null>) {
  const [isCinema, setIsCinema] = useState(false);
  // Read by the unmount cleanup, which must not restore an orientation it never changed.
  const isCinemaRef = useRef(false);

  const enter = useCallback(() => {
    setIsCinema(true);
    isCinemaRef.current = true;
    void enterLandscape(ref.current);
  }, [ref]);

  const exit = useCallback(() => {
    setIsCinema(false);
    isCinemaRef.current = false;
    void restoreOrientation();
  }, []);

  // Back should leave the stream, not the app. Capacitor exits on back when nothing is
  // listening, so this listener exists only while there is something to back out of.
  useEffect(() => {
    if (!isCinema || !isCapacitor()) return;

    let handle: PluginListenerHandle | undefined;
    let cancelled = false;

    void App.addListener("backButton", exit).then((h) => {
      if (cancelled) void h.remove();
      else handle = h;
    });

    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [isCinema, exit]);

  // The call ends, the stream stops, the panel goes away — and the phone must not be left
  // sideways looking at a portrait app.
  useEffect(
    () => () => {
      if (isCinemaRef.current) void restoreOrientation();
    },
    []
  );

  return { isCinema, enter, exit };
}
