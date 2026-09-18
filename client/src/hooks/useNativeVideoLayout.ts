/** Keeps the native video views on the call screen's boxes, with holes where the page draws over them. */

import { useEffect, useRef } from "react";
import type { PluginListenerHandle } from "@capacitor/core";

import { NativeP2PCall } from "../native/nativeP2PCall";

/** Matches the PiP's border radius in globals.css, so the native corner follows the CSS one. */
const PIP_CORNER_RADIUS = 8;
/** Keeps the samples off the box's own border, where the hit test can land on a neighbour. */
const SAMPLE_INSET = 2;
/** Hit-testing for overlays runs at most this often, even while boxes are tracked every frame. */
const OCCLUSION_INTERVAL_MS = 100;
/** After a change or user input, measure every frame for this long. */
const BUSY_MS = 500;
/** Otherwise measure this often: the page still moves or gets covered without input. */
const IDLE_INTERVAL_MS = 250;
/** Input that is about to move a box or open something over it. */
const WAKE_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "resize", "orientationchange"];

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

/** Samples per side of each box; denser catches smaller overlays. */
const GRID = 5;

/** The overlay a hit belongs to: its top-most box short of the video, skipping pass-through layers. */
function overlayRoot(hit: Element, boxes: readonly (HTMLElement | null)[]): Element {
  const chain: Element[] = [];
  for (let el: Element | null = hit; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (boxes.some((box) => box !== null && el.contains(box))) break;
    chain.push(el);
  }
  // A pointer-events:none layer (a toast container, say) spans far more than what it shows.
  for (let i = chain.length - 1; i >= 0; i--) {
    if (getComputedStyle(chain[i]).pointerEvents !== "none") return chain[i];
  }
  return hit;
}

function overlaps(a: NonNullable<Rect>, b: NonNullable<Rect>): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function union(a: NonNullable<Rect>, b: NonNullable<Rect>): NonNullable<Rect> {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * What the page draws over the video boxes, as rectangles for the native layer to cut out.
 * Overlapping ones are merged: the native mask cuts with even-odd filling.
 */
export function coverings(
  rects: readonly Rect[],
  clip: Rect,
  boxes: readonly (HTMLElement | null)[],
): NonNullable<Rect>[] {
  if (!clip) return [];
  const found = new Set<Element>();
  for (const rect of rects) {
    if (!rect) continue;
    // Only the part inside the call area is drawn, so only that part is sampled.
    const left = Math.max(rect.x, clip.x) + SAMPLE_INSET;
    const top = Math.max(rect.y, clip.y) + SAMPLE_INSET;
    const right = Math.min(rect.x + rect.width, clip.x + clip.width) - SAMPLE_INSET;
    const bottom = Math.min(rect.y + rect.height, clip.y + clip.height) - SAMPLE_INSET;
    if (right <= left || bottom <= top) continue;
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        const x = left + ((right - left) * i) / (GRID - 1);
        const y = top + ((bottom - top) * j) / (GRID - 1);
        const hit = document.elementFromPoint(x, y);
        if (!hit || boxes.some((box) => box !== null && (box === hit || box.contains(hit)))) continue;
        found.add(overlayRoot(hit, boxes));
      }
    }
  }

  const holes: NonNullable<Rect>[] = [];
  for (const el of found) {
    const r = el.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1) holes.push({ x: r.left, y: r.top, width: r.width, height: r.height });
  }
  // Merge until no two overlap: a merged hole can reach one it did not touch before.
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < holes.length && !merged; i++) {
      for (let j = i + 1; j < holes.length; j++) {
        if (!overlaps(holes[i], holes[j])) continue;
        holes[i] = union(holes[i], holes[j]);
        holes.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  return holes;
}

function sameHoles(a: readonly Rect[], b: readonly Rect[]): boolean {
  return a.length === b.length && a.every((hole, i) => same(hole, b[i]));
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
    const record = (source: "remote" | "local", width: number, height: number) => {
      shapes.current[source] = `${width} / ${height}`;
      apply();
    };
    void NativeP2PCall.addListener("videoSize", (data) => record(data.source, data.width, data.height))
      .then(async (listener) => {
        if (cancelled) {
          void listener.remove();
          return;
        }
        handle = listener;
        // Sizes reported before this subscribed; events are not retained.
        const sizes = await NativeP2PCall.getVideoSizes();
        if (cancelled) return;
        if (sizes.remote) record("remote", sizes.remote.width, sizes.remote.height);
        if (sizes.local) record("local", sizes.local.width, sizes.local.height);
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
    let busyUntil = 0;
    let lastRun = 0;
    let lastOcclusion = -Infinity;
    let holes: NonNullable<Rect>[] = [];
    let lastHoles: NonNullable<Rect>[] = [];

    const publish = (now: number) => {
      const clip = rectOf(clipEl);
      const remote = rectOf(remoteEl);
      const local = rectOf(localEl);
      if (now - lastOcclusion >= OCCLUSION_INTERVAL_MS) {
        lastOcclusion = now;
        holes = coverings([remote, local], clip, boxes);
      }
      if (
        !first &&
        same(clip, lastClip) &&
        same(remote, lastRemote) &&
        same(local, lastLocal) &&
        sameHoles(holes, lastHoles)
      ) {
        return;
      }
      first = false;
      lastHoles = holes;
      busyUntil = now + BUSY_MS;
      lastClip = clip;
      lastRemote = remote;
      lastLocal = local;
      void NativeP2PCall.setVideoLayout({
        clip,
        remote,
        local,
        holes,
        cornerRadius: PIP_CORNER_RADIUS,
        mirrorLocal,
      }).catch((err) => console.error("[p2p] native setVideoLayout failed:", err));
    };

    // Rects move and get covered without events, so this polls: every frame while something is
    // happening, a few times a second otherwise — a long call would keep the thread busy for nothing.
    const tick = (now: number) => {
      if (now < busyUntil || now - lastRun >= IDLE_INTERVAL_MS) {
        lastRun = now;
        publish(now);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    const wake = () => {
      busyUntil = performance.now() + BUSY_MS;
    };
    for (const type of WAKE_EVENTS) window.addEventListener(type, wake, { capture: true, passive: true });
    window.visualViewport?.addEventListener("resize", wake);

    return () => {
      cancelAnimationFrame(frame);
      for (const type of WAKE_EVENTS) window.removeEventListener(type, wake, { capture: true });
      window.visualViewport?.removeEventListener("resize", wake);
      void NativeP2PCall.hideVideo().catch(() => {});
    };
  }, [active, clipEl, remoteEl, localEl, mirrorLocal]);
}
