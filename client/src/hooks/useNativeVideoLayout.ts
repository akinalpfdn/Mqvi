/**
 * Keeps the native video views sitting exactly where the call screen's boxes are.
 *
 * On iOS the two feeds are drawn behind the web view, so the page cannot contain them — it can
 * only say where they belong. This hook measures the media area and the picture-in-picture box
 * and sends those rectangles down whenever they move: layout changes, rotation, cinema mode,
 * fullscreen, dragging the PiP, switching tabs.
 */

import { useEffect, useRef } from "react";
import type { PluginListenerHandle } from "@capacitor/core";

import { NativeP2PCall } from "../native/nativeP2PCall";

/** Matches the PiP's border radius in globals.css, so the native corner follows the CSS one. */
const PIP_CORNER_RADIUS = 8;

type Rect = { x: number; y: number; width: number; height: number } | null;

function rectOf(element: HTMLElement | null): Rect {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

function same(a: Rect, b: Rect): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

export function useNativeVideoLayout(options: {
  active: boolean;
  /** The call area the feeds are confined to — the box the page clips them against. */
  clipEl: HTMLElement | null;
  remoteEl: HTMLElement | null;
  localEl: HTMLElement | null;
  mirrorLocal: boolean;
}): void {
  const { active, clipEl, remoteEl, localEl, mirrorLocal } = options;

  // Last shape reported for each feed, kept so a swap can re-apply it: the picture-in-picture
  // box changes which feed it holds, and the native side only reports a shape when it changes.
  const shapes = useRef<{ remote: string | null; local: string | null }>({ remote: null, local: null });

  // The page cannot measure a picture it does not hold, so the box that frames a natively drawn
  // feed gets its aspect ratio from the feed itself. Without it an empty <video> falls back to
  // the browser's 300x150 default and a portrait camera is framed landscape.
  useEffect(() => {
    if (!active) return;

    const apply = () => {
      for (const [element, aspect] of [
        [remoteEl, shapes.current.remote],
        [localEl, shapes.current.local],
      ] as const) {
        if (!element) continue;
        if (aspect) element.style.setProperty("--pip-aspect", aspect);
        else element.style.removeProperty("--pip-aspect");
      }
    };
    apply();

    let handle: PluginListenerHandle | null = null;
    let cancelled = false;
    void NativeP2PCall.addListener("videoSize", (data) => {
      shapes.current[data.source] = `${data.width} / ${data.height}`;
      apply();
    })
      .then((listener) => {
        if (cancelled) void listener.remove();
        else handle = listener;
      })
      .catch((err) => console.error("[p2p] native videoSize listener failed:", err));

    return () => {
      cancelled = true;
      void handle?.remove();
    };
  }, [active, remoteEl, localEl]);

  useEffect(() => {
    if (!active) {
      console.log("[p2p] video layout inactive — native surface hidden");
      void NativeP2PCall.hideVideo().catch(() => {});
      return;
    }

    let lastClip: Rect = null;
    let lastRemote: Rect = null;
    let lastLocal: Rect = null;
    let first = true;
    let frame = 0;

    const publish = () => {
      const clip = rectOf(clipEl);
      const remote = rectOf(remoteEl);
      const local = rectOf(localEl);
      if (!first && same(clip, lastClip) && same(remote, lastRemote) && same(local, lastLocal)) return;
      console.log(
        `[p2p] video layout: remote=${remote ? `${Math.round(remote.width)}x${Math.round(remote.height)}` : "none"}` +
          ` local=${local ? `${Math.round(local.width)}x${Math.round(local.height)}` : "none"}` +
          ` (elements: remote=${remoteEl ? "yes" : "no"} local=${localEl ? "yes" : "no"})`,
      );
      first = false;
      lastClip = clip;
      lastRemote = remote;
      lastLocal = local;
      void NativeP2PCall.setVideoLayout({
        clip,
        remote,
        local,
        cornerRadius: PIP_CORNER_RADIUS,
        mirrorLocal,
      }).catch((err) => console.error("[p2p] native setVideoLayout failed:", err));
    };

    // A rect can move without any event firing — the PiP is dragged with transforms, cinema
    // mode animates, the keyboard pushes the layout. Polling on animation frames is the only
    // thing that catches all of it, and it is two getBoundingClientRect calls per frame.
    const tick = () => {
      publish();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      void NativeP2PCall.hideVideo().catch(() => {});
    };
  }, [active, clipEl, remoteEl, localEl, mirrorLocal]);
}
