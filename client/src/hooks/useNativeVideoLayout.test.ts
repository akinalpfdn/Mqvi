/** A box the page covers is withheld from the native layer, which would hide the cover. */
import { describe, it, expect, afterEach } from "vitest";

import { uncovered, type Rect } from "./useNativeVideoLayout";

const CLIP: Rect = { x: 0, y: 0, width: 400, height: 800 };
const BOX: Rect = { x: 0, y: 0, width: 400, height: 800 };

/** jsdom has no hit testing; stand in the page's answer for each point. */
function topmostAt(pick: (x: number, y: number) => Element | null) {
  document.elementFromPoint = pick;
}

afterEach(() => {
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

describe("uncovered", () => {
  const surface = document.createElement("div");
  const pip = document.createElement("div");
  const pipInner = document.createElement("video");
  pip.appendChild(pipInner);
  const menu = document.createElement("div");

  it("should keep a box whose every point is the box itself", () => {
    topmostAt(() => surface);
    expect(uncovered(BOX, CLIP, [surface, pip])).toEqual(BOX);
  });

  it("should keep a box that the other video box overlaps", () => {
    // The picture-in-picture over the big feed is drawn natively too, in the right order.
    topmostAt((x, y) => (x > 300 && y > 700 ? pipInner : surface));
    expect(uncovered(BOX, CLIP, [surface, pip])).toEqual(BOX);
  });

  it("should withhold a box that anything else covers, even in part", () => {
    topmostAt((x, y) => (x < 100 && y < 100 ? menu : surface));
    expect(uncovered(BOX, CLIP, [surface, pip])).toBeNull();
  });

  it("should ignore points that fall off the screen", () => {
    topmostAt(() => null);
    expect(uncovered(BOX, CLIP, [surface, pip])).toEqual(BOX);
  });

  it("should only sample the part of a box inside the call area", () => {
    // Half of the box hangs outside the call area, where the page shows something else — that
    // half is clipped away natively too, so it cannot count as covered.
    const box: Rect = { x: 200, y: 0, width: 400, height: 800 };
    topmostAt((x) => (x > 400 ? menu : surface));
    expect(uncovered(box, CLIP, [surface, pip])).toEqual(box);
  });
});
