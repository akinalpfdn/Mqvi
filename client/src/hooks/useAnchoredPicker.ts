/** Fixed-position placement for chat-column pickers.
 *
 *  `.chat-area` is both `position:relative` and `overflow-x:hidden`, so it is the containing block
 *  for an absolutely positioned popover AND clips it at the column edge. The pickers therefore
 *  portal to <body>, which takes placement away from CSS — this computes it instead: the roomier
 *  side of the anchor, capped to the room that side has, clamped inside the window horizontally.
 */

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Gap to the anchor (mirrors the 6px margin the in-flow variants use), clearance to the window
 *  edge, and the smallest panel still worth showing rather than collapsing to a sliver. */
const GAP = 6;
const EDGE = 8;
const MIN_HEIGHT = 220;

/** Low bound wins when the window is too small for both — the panel stays reachable. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(value, hi));
}

type AnchoredBox = {
  top: number;
  left: number;
  maxHeight: number;
};

type AnchoredPicker = {
  /** Render this in the original tree — its parent is the wrapper holding the trigger button. */
  markerRef: RefObject<HTMLSpanElement | null>;
  /** Null until measured; render the panel hidden while it is. */
  box: AnchoredBox | null;
};

function useAnchoredPicker(active: boolean, panelRef: RefObject<HTMLElement | null>): AnchoredPicker {
  const markerRef = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<AnchoredBox | null>(null);

  // Layout effect, not effect: the position has to land before paint or the panel shows for one
  // frame at the top-left corner.
  useLayoutEffect(() => {
    if (!active) return;
    const anchor = markerRef.current?.parentElement;
    if (!anchor) return;

    const place = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const a = anchor.getBoundingClientRect();
      const above = a.top - GAP - EDGE;
      const below = window.innerHeight - a.bottom - GAP - EDGE;
      const openDown = below > above;
      const room = Math.max(MIN_HEIGHT, Math.floor(openDown ? below : above));
      const height = Math.min(panel.offsetHeight, room);
      const width = panel.offsetWidth;
      // Right edge to the trigger's right edge, then pulled back inside the window. The clamp is
      // what CSS could not do: `right:0` on a trigger near the left edge put most of the panel
      // outside the column, which is how it ended up cut off.
      const left = clamp(a.right - width, EDGE, window.innerWidth - width - EDGE);
      // MIN_HEIGHT can exceed what the roomier side actually has on a short window, so the
      // preferred position is clamped too: overlapping the trigger beats hanging off-screen.
      const top = clamp(
        openDown ? a.bottom + GAP : a.top - GAP - height,
        EDGE,
        window.innerHeight - height - EDGE
      );
      const next = { top: Math.round(top), left: Math.round(left), maxHeight: room };
      // Only on a real change: `place` runs from a ResizeObserver watching this same panel, and an
      // unconditional setState would re-render it into another observation forever.
      setBox((prev) =>
        prev && prev.top === next.top && prev.left === next.left && prev.maxHeight === next.maxHeight
          ? prev
          : next
      );
    };

    place();
    // The panel is measured the frame it mounts, before the emoji grid (a web component) or the
    // GIF thumbnails have laid out — height reads near zero then, which put the panel a few pixels
    // under the trigger and let the finished content run off the bottom of the screen. Re-place
    // whenever its size settles.
    const ro = new ResizeObserver(place);
    if (panelRef.current) ro.observe(panelRef.current);
    window.addEventListener("resize", place);
    // Capture phase: the message list is the scroller, not the window, and a fixed panel would
    // otherwise stay put while its trigger scrolled away.
    window.addEventListener("scroll", place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [active, panelRef]);

  return { markerRef, box };
}

export { useAnchoredPicker, type AnchoredBox };
