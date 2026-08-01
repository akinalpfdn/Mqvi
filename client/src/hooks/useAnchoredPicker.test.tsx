/** Geometry for the chat-column pickers. Every case here is a way the panel actually ended up
 *  off-screen — the class of bug no existing test could catch, because jsdom reports every
 *  element as 0x0 unless the measurements are stubbed as they are below. */

import { render, screen, act } from "@testing-library/react";
import { useRef } from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useAnchoredPicker } from "./useAnchoredPicker";
import { ResizeObserverStub } from "../test/resizeObserverStub";

const GAP = 6;
const EDGE = 8;

type Rect = { top: number; bottom: number; left: number; right: number };

/** Measurements the real browser would supply, keyed by data-testid. */
const measurements = {
  anchor: { top: 0, bottom: 0, left: 0, right: 0 } as Rect,
  panel: { width: 0, height: 0 },
};

const originalRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  ResizeObserverStub.reset();
  window.innerWidth = 1400;
  window.innerHeight = 900;

  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    if (this.dataset.testid !== "anchor") return originalRect.call(this);
    const r = measurements.anchor;
    return {
      ...r,
      width: r.right - r.left,
      height: r.bottom - r.top,
      x: r.left,
      y: r.top,
      toJSON: () => "",
    } as DOMRect;
  };

  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(): number {
      return (this as HTMLElement).dataset.testid === "panel" ? measurements.panel.width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(): number {
      return (this as HTMLElement).dataset.testid === "panel" ? measurements.panel.height : 0;
    },
  });
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
});

function Harness() {
  const panelRef = useRef<HTMLDivElement>(null);
  const { markerRef, box } = useAnchoredPicker(true, panelRef);
  return (
    <div data-testid="anchor">
      <span ref={markerRef} />
      <div ref={panelRef} data-testid="panel" />
      <output data-testid="box">{box ? `${box.top}|${box.left}|${box.maxHeight}` : "unplaced"}</output>
    </div>
  );
}

function placed(): { top: number; left: number; maxHeight: number } {
  const [top, left, maxHeight] = screen.getByTestId("box").textContent!.split("|").map(Number);
  return { top, left, maxHeight };
}

describe("useAnchoredPicker", () => {
  it("should open below the trigger when the room below is greater", () => {
    measurements.anchor = { top: 100, bottom: 130, left: 600, right: 640 };
    measurements.panel = { width: 350, height: 435 };

    render(<Harness />);

    expect(placed().top).toBe(130 + GAP);
  });

  it("should open above the trigger when the room above is greater", () => {
    measurements.anchor = { top: 700, bottom: 730, left: 600, right: 640 };
    measurements.panel = { width: 350, height: 435 };

    render(<Harness />);

    // Its bottom edge sits one gap above the trigger.
    expect(placed().top).toBe(700 - GAP - 435);
  });

  it("should keep the panel on screen when it lays out after mount", () => {
    // The real failure: emoji-mart is a web component, so the panel is empty the frame it mounts.
    // Placing from that zero height put the top just under the trigger, and the finished grid then
    // ran off the bottom of the window.
    measurements.anchor = { top: 700, bottom: 730, left: 600, right: 640 };
    measurements.panel = { width: 0, height: 0 };

    render(<Harness />);
    const beforeLayout = placed().top;

    act(() => {
      measurements.panel = { width: 350, height: 435 };
      ResizeObserverStub.flush();
    });

    const after = placed();
    expect(after.top).not.toBe(beforeLayout);
    expect(after.top + 435).toBeLessThanOrEqual(window.innerHeight);
    expect(after.top).toBeGreaterThanOrEqual(EDGE);
  });

  it("should pull the panel back inside the window when the trigger is near the left edge", () => {
    // Right-aligning a 350px panel to a trigger at x=40 put 310px of it outside the column — this
    // is the clipping that `.chat-area { overflow-x:hidden }` was cutting off.
    measurements.anchor = { top: 100, bottom: 130, left: 20, right: 40 };
    measurements.panel = { width: 350, height: 435 };

    render(<Harness />);

    expect(placed().left).toBe(EDGE);
  });

  it("should pull the panel back inside the window when the trigger is near the right edge", () => {
    measurements.anchor = { top: 100, bottom: 130, left: 1380, right: 1398 };
    measurements.panel = { width: 350, height: 435 };

    render(<Harness />);

    expect(placed().left).toBe(1400 - 350 - EDGE);
  });

  it("should stay on screen when neither side can fit the minimum height", () => {
    // Short window: the floor at MIN_HEIGHT is taller than the room either side has, so the
    // preferred position has to be clamped rather than trusted.
    window.innerHeight = 320;
    measurements.anchor = { top: 150, bottom: 180, left: 600, right: 640 };
    measurements.panel = { width: 350, height: 300 };

    render(<Harness />);

    const { top, maxHeight } = placed();
    expect(top).toBeGreaterThanOrEqual(EDGE);
    expect(top + Math.min(300, maxHeight)).toBeLessThanOrEqual(320);
  });
});
