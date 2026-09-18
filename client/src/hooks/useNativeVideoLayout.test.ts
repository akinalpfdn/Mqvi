/** What the page draws over the native video is cut out of it, overlay by overlay. */
import { describe, it, expect, afterEach } from "vitest";

import { coverings, type Rect } from "./useNativeVideoLayout";

const CLIP: Rect = { x: 0, y: 0, width: 400, height: 800 };
const BOX: Rect = { x: 0, y: 0, width: 400, height: 800 };

/** jsdom has no hit testing; stand in the page's answer for each point. */
function topmostAt(pick: (x: number, y: number) => Element | null) {
  document.elementFromPoint = pick;
}

/** jsdom has no layout either. */
function placed<T extends HTMLElement>(el: T, x: number, y: number, width: number, height: number): T {
  el.getBoundingClientRect = () => ({ left: x, top: y, width, height }) as DOMRect;
  return el;
}

afterEach(() => {
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  document.body.innerHTML = "";
});

describe("coverings", () => {
  const surface = document.createElement("div");
  const pip = document.createElement("div");
  const pipInner = document.createElement("video");
  pip.appendChild(pipInner);

  it("should find nothing when every point is a video box", () => {
    topmostAt(() => surface);
    expect(coverings([BOX], CLIP, [surface, pip])).toEqual([]);
  });

  it("should not treat the picture-in-picture over the big feed as a cover", () => {
    topmostAt((x, y) => (x > 300 && y > 700 ? pipInner : surface));
    expect(coverings([BOX], CLIP, [surface, pip])).toEqual([]);
  });

  it("should cut out just the overlay, not the whole feed", () => {
    const menu = placed(document.createElement("div"), 10, 10, 120, 90);
    document.body.appendChild(menu);
    topmostAt((x, y) => (x < 130 && y < 100 ? menu : surface));
    expect(coverings([BOX], CLIP, [surface, pip])).toEqual([{ x: 10, y: 10, width: 120, height: 90 }]);
  });

  it("should take the overlay's own box, not a pass-through layer around it", () => {
    const layer = placed(document.createElement("div"), 0, 0, 400, 800);
    layer.style.pointerEvents = "none";
    const toast = placed(document.createElement("div"), 20, 700, 200, 60);
    toast.style.pointerEvents = "auto"; // as a real toast does, or the browser would never hit it
    const text = placed(document.createElement("span"), 30, 710, 50, 20);
    toast.appendChild(text);
    layer.appendChild(toast);
    document.body.appendChild(layer);
    topmostAt((x, y) => (y > 700 && x < 220 ? text : surface));
    expect(coverings([BOX], CLIP, [surface, pip])).toEqual([{ x: 20, y: 700, width: 200, height: 60 }]);
  });

  it("should merge overlays that overlap, including ones joined by a merge", () => {
    const a = placed(document.createElement("div"), 0, 0, 100, 100);
    const b = placed(document.createElement("div"), 250, 0, 100, 100);
    const c = placed(document.createElement("div"), 90, 0, 170, 50); // bridges a and b
    document.body.append(a, b, c);
    topmostAt((x, y) => {
      if (y > 100) return surface;
      if (x < 100) return a;
      if (x > 260) return b;
      return c;
    });
    expect(coverings([BOX], CLIP, [surface, pip])).toEqual([{ x: 0, y: 0, width: 350, height: 100 }]);
  });

  it("should ignore points that fall off the screen", () => {
    topmostAt(() => null);
    expect(coverings([BOX], CLIP, [surface, pip])).toEqual([]);
  });
});
