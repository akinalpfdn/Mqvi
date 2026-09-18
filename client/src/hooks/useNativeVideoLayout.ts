/**
 * Keeps the native video views sitting exactly where the call screen's boxes are.
 *
 * On iOS the two feeds are drawn in native views layered over the web view, so the page cannot
 * contain them — it can only say where they belong. This hook measures the media area and the
 * picture-in-picture box and sends those rectangles down whenever they move: layout changes,
 * rotation, cinema mode, fullscreen, dragging the PiP, switching tabs. Being on top also means
 * the page cannot draw over the video, so a box the page covers is withheld; see `uncovered`.
 */

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
 * `rect` if the page leaves it uncovered, otherwise null.
 *
 * A native view draws over everything the page renders, so anything the page puts over a video
 * box — the stream context menu, the incoming-call overlay, a toast, the drawer, a settings or
 * report modal — would sit underneath the video, unseen and unusable. Rather than have every
 * overlay announce itself (and the next one added forget to), this asks the page directly: a
 * 3×3 grid of points inside the box, and at each the topmost element must be one of the video
 * boxes. Anything else on top means the box is covered, and its view stays hidden until it is
 * not. All-or-nothing, since a native view cannot be partially masked by the page.
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

    // A rect can move, or be covered, without any event firing — the PiP is dragged with
    // transforms, cinema mode animates, the keyboard pushes the layout, a modal opens elsewhere
    // in the app. Polling on animation frames is the only thing that catches all of it: two
    // getBoundingClientRect calls and at most eighteen hit tests per frame.
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
