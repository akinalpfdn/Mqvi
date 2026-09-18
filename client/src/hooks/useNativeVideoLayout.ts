/** Keeps the native video views on the call screen's boxes, and off any box the page covers. */

import { useEffect, useRef } from "react";
import type { PluginListenerHandle } from "@capacitor/core";

import { NativeP2PCall } from "../native/nativeP2PCall";

/** Matches the PiP's border radius in globals.css, so the native corner follows the CSS one. */
const PIP_CORNER_RADIUS = 8;
/** Keeps the samples off the box's own border, where the hit test can land on a neighbour. */
const SAMPLE_INSET = 2;

export type Rect = { x: number; y: number; width: number; height: number } | null;

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

/**
 * `rect` unless the page draws something over it, which a native view would hide.
 * Samples a 3x3 grid instead of every overlay having to announce itself.
 */
export function uncovered(rect: Rect, clip: Rect, boxes: readonly (HTMLElement | null)[]): Rect {
  if (!rect || !clip) return rect;
  // Only the part inside the call area is drawn, so only that part is sampled.
  const left = Math.max(rect.x, clip.x) + SAMPLE_INSET;
  const top = Math.max(rect.y, clip.y) + SAMPLE_INSET;
  const right = Math.min(rect.x + rect.width, clip.x + clip.width) - SAMPLE_INSET;
  const bottom = Math.min(rect.y + rect.height, clip.y + clip.height) - SAMPLE_INSET;
  if (right <= left || bottom <= top) return rect;

  for (const fx of [0, 0.5, 1]) {
    for (const fy of [0, 0.5, 1]) {
      const hit = document.elementFromPoint(left + (right - left) * fx, top + (bottom - top) * fy);
      if (!hit) continue; // off-screen: nothing there to cover it
      if (!boxes.some((box) => box !== null && (box === hit || box.contains(hit)))) return null;
    }
  }
  return rect;
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

  // Boxes for native feeds take their aspect ratio from the feed; an empty <video> defaults to 2:1.
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
      void NativeP2PCall.hideVideo().catch(() => {});
      return;
    }

    const boxes = [remoteEl, localEl] as const;
    let lastClip: Rect = null;
    let lastRemote: Rect = null;
    let lastLocal: Rect = null;
    let first = true;
    let frame = 0;

    const publish = () => {
      const clip = rectOf(clipEl);
      const remote = uncovered(rectOf(remoteEl), clip, boxes);
      const local = uncovered(rectOf(localEl), clip, boxes);
      if (!first && same(clip, lastClip) && same(remote, lastRemote) && same(local, lastLocal)) return;
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

    // Rects move and get covered without events; polling each frame catches all of it.
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
