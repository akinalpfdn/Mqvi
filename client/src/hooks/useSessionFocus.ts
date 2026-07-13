/**
 * useSessionFocus — tells the server what this device currently has on screen, so a DM the
 * user is already reading somewhere doesn't also buzz their phone. This is the WhatsApp Web
 * contract: the chat open in front of you does not notify you a second time.
 *
 * Two things have to be true for the server to suppress: the window is focused, and the
 * chat is the active tab. Backgrounding sends focused=false immediately — the server treats
 * a stale claim as no claim (see Hub.focusTTL), but only after a delay, so saying so
 * explicitly is what keeps a pocketed phone from silencing its own notifications.
 *
 * Singleton — mount once, in AppLayout, next to useWebSocket.
 */

import { useEffect, useRef } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import { App } from "@capacitor/app";

import { useUIStore } from "../stores/uiStore";
import { isCapacitor } from "../utils/constants";

type FocusView = { type: "dm" | "channel"; id: string };
type FocusPayload = { focused: boolean; views: FocusView[] };

type Params = {
  sendWS: (op: string, data?: unknown) => void;
  connectionStatus: string;
};

/** Visible AND focused — a window sitting behind another app should still notify. */
function isWindowFocused(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

/** The active tab of every panel. A split view shows more than one chat at a time. */
function visibleViews(): FocusView[] {
  const { panels } = useUIStore.getState();
  const views: FocusView[] = [];

  for (const panel of Object.values(panels)) {
    const tab = panel.tabs.find((t) => t.id === panel.activeTabId);
    if (!tab) continue;
    if (tab.type === "dm") views.push({ type: "dm", id: tab.channelId });
    else if (tab.type === "text") views.push({ type: "channel", id: tab.channelId });
  }
  return views;
}

export function useSessionFocus({ sendWS, connectionStatus }: Params): void {
  const lastSentRef = useRef<string | null>(null);

  useEffect(() => {
    // A dropped socket loses the server's copy of our focus, so forget what we think it
    // knows — the reconnect effect below re-asserts from scratch.
    if (connectionStatus !== "connected") {
      lastSentRef.current = null;
      return;
    }

    function publish(): void {
      const payload: FocusPayload = { focused: isWindowFocused(), views: visibleViews() };
      // Unfocused is a single fact; the tabs behind it don't matter and would only churn.
      if (!payload.focused) payload.views = [];

      const encoded = JSON.stringify(payload);
      if (encoded === lastSentRef.current) return;
      lastSentRef.current = encoded;
      sendWS("focus_update", payload);
    }

    publish(); // assert on (re)connect — the server starts with no focus for this session

    const onVisibility = (): void => publish();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    window.addEventListener("blur", onVisibility);

    // Tab/panel switches change which chats are on screen.
    const unsubscribeUI = useUIStore.subscribe(publish);

    // Android/iOS: visibilitychange fires on background in most WebViews, but this is the
    // signal the platform actually guarantees — and getting it wrong swallows notifications.
    let appHandle: PluginListenerHandle | null = null;
    if (isCapacitor()) {
      void App.addListener("appStateChange", publish)
        .then((h) => {
          appHandle = h;
        })
        .catch((err) => console.error("[focus] appStateChange listener failed:", err));
    }

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      window.removeEventListener("blur", onVisibility);
      unsubscribeUI();
      void appHandle?.remove();
    };
  }, [sendWS, connectionStatus]);
}
