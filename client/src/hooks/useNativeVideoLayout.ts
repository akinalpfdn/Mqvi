/**
 * Keeps the native video views sitting exactly where the call screen's boxes are.
 *
 * On iOS the two feeds are drawn behind the web view, so the page cannot contain them — it can
 * only say where they belong. This hook measures the media area and the picture-in-picture box
 * and sends those rectangles down whenever they move: layout changes, rotation, cinema mode,
 * fullscreen, dragging the PiP, switching tabs.
 */

import { useEffect } from "react";

import { NativeP2PCall } from "../native/nativeP2PCall";

/** Matches the PiP's border radius in globals.css, so the native corner follows the CSS one. */
const PIP_CORNER_RADIUS = 10;

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
  remoteEl: HTMLElement | null;
  localEl: HTMLElement | null;
  mirrorLocal: boolean;
}): void {
  const { active, remoteEl, localEl, mirrorLocal } = options;

  useEffect(() => {
    if (!active) {
      void NativeP2PCall.hideVideo().catch(() => {});
      return;
    }

    let lastRemote: Rect = null;
    let lastLocal: Rect = null;
    let first = true;
    let frame = 0;

    const publish = () => {
      const remote = rectOf(remoteEl);
      const local = rectOf(localEl);
      if (!first && same(remote, lastRemote) && same(local, lastLocal)) return;
      first = false;
      lastRemote = remote;
      lastLocal = local;
      void NativeP2PCall.setVideoLayout({
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
  }, [active, remoteEl, localEl, mirrorLocal]);
}
