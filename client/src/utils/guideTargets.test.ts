/** Which control "Show me" points at. */
import { describe, it, expect, beforeEach } from "vitest";

import { findTourTarget, tourCaptionKey } from "./guideTargets";

function add(tour: string, { shown = true, active = false } = {}) {
  const el = document.createElement("button");
  el.dataset.tour = tour;
  if (active) el.classList.add("active");
  el.getBoundingClientRect = () => ({ width: shown ? 100 : 0, height: shown ? 30 : 0, top: 0, left: 0 }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("finding where to point", () => {
  it("takes the most preferred target that is on screen", () => {
    add("discover");
    const channel = add("channel-text");
    expect(findTourTarget(["channel-text", "discover"])?.element).toBe(channel);
  });

  it("falls back when the preferred target does not exist yet", () => {
    const server = add("server");
    expect(findTourTarget(["channel-text", "server", "discover"])).toMatchObject({ target: "server", element: server });
  });

  it("skips a target that is in the DOM but not shown (a collapsed section)", () => {
    add("channel-text", { shown: false });
    const discover = add("discover");
    expect(findTourTarget(["channel-text", "discover"])?.element).toBe(discover);
  });

  it("prefers the active row among several", () => {
    add("server");
    const active = add("server", { active: true });
    expect(findTourTarget(["server"])?.element).toBe(active);
  });

  it("finds nothing when no target is there", () => {
    expect(findTourTarget(["friends"])).toBeNull();
  });

  it("explains a fallback with the fallback's own caption", () => {
    expect(tourCaptionKey("message", "channel-text", "channel-text")).toBe("spotlight.message");
    expect(tourCaptionKey("message", "channel-text", "server")).toBe("spotlight.fallback.server");
  });
});
