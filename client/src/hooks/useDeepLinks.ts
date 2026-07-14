/**
 * useDeepLinks — routes a tapped mqvi.net link into the app (Capacitor only).
 */

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { App } from "@capacitor/app";
import { isCapacitor } from "../utils/constants";
import { deepLinkPath } from "../utils/deepLink";

/**
 * Two entry points, because a link arrives differently depending on whether the app was already
 * running: appUrlOpen fires on a live app, while a cold start delivers the intent before any
 * listener exists — that one is only readable from getLaunchUrl.
 *
 * Navigating through the router (not window.location) is not optional: on native the app runs on
 * a HashRouter, so the route lives in the hash and an incoming path means nothing to the browser.
 */
export function useDeepLinks(): void {
  const navigate = useNavigate();
  // The launch URL never expires — reading it again after the user has moved on would yank them
  // back to the link they opened the app with.
  const launchUrlConsumed = useRef(false);

  useEffect(() => {
    if (!isCapacitor()) return;

    let cancelled = false;
    let removeListener: (() => void) | undefined;

    function open(url: string | null | undefined) {
      if (cancelled || !url) return;
      const path = deepLinkPath(url);
      if (path) navigate(path);
    }

    void App.addListener("appUrlOpen", ({ url }) => open(url)).then((handle) => {
      if (cancelled) {
        void handle.remove();
        return;
      }
      removeListener = () => void handle.remove();
    });

    if (!launchUrlConsumed.current) {
      launchUrlConsumed.current = true;
      void App.getLaunchUrl().then((result) => open(result?.url));
    }

    return () => {
      cancelled = true;
      removeListener?.();
    };
  }, [navigate]);
}
