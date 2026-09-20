/** What the page draws over the native video is cut out of it, overlay by overlay. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ResizeObserverStub } from "../test/resizeObserverStub";

const { hideVideo, setVideoLayout } = vi.hoisted(() => ({ hideVideo: vi.fn(async () => {}), setVideoLayout: vi.fn(async () => {}) }));
vi.mock("../native/nativeP2PCall", () => ({
  NativeP2PCall: {
    hideVideo,
    setVideoLayout,
    getVideoSizes: vi.fn(async () => ({})),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  },
}));

import { coverings, useNativeVideoLayout, type Rect } from "./useNativeVideoLayout";

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
  vi.useRealTimers();
  vi.restoreAllMocks();
  ResizeObserverStub.reset();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  document.body.innerHTML = "";
});

describe("native video occlusion invalidation", () => {
  async function setup() {
    vi.useFakeTimers();
    setVideoLayout.mockClear();
    const clip = placed(document.createElement("div"), 0, 0, 400, 600);
    const surface = placed(document.createElement("div"), 0, 0, 400, 600);
    clip.append(surface);
    document.body.append(clip);
    const pick = vi.fn((): Element => surface);
    topmostAt(pick);
    const hook = renderHook(() => useNativeVideoLayout({
      active: true, clipEl: clip, remoteEl: surface, localEl: null, mirrorLocal: true,
    }));
    await act(() => vi.advanceTimersByTimeAsync(600));
    return { ...hook, surface, pick };
  }

  it("does no grid hit tests on an uncovered video, including after input and clock ticks", async () => {
    const { unmount, pick } = await setup();
    const clock = placed(document.createElement("span"), 0, 650, 100, 20);
    document.body.append(clock);
    await act(async () => {
      window.dispatchEvent(new Event("pointermove"));
      clock.textContent = "00:02";
      await vi.advanceTimersByTimeAsync(2000);
      clock.textContent = "00:03";
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(pick).not.toHaveBeenCalled();
    expect(setVideoLayout).toHaveBeenCalledWith(expect.objectContaining({ holes: [] }));
    unmount();
  });

  it("detects a portal without input, caches a static overlay, and clears its hole on removal", async () => {
    const { unmount, surface, pick } = await setup();
    const overlay = placed(document.createElement("div"), 0, 0, 100, 80);
    await act(async () => {
      pick.mockImplementation(() => overlay);
      document.body.append(overlay);
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(setVideoLayout).toHaveBeenLastCalledWith(expect.objectContaining({ holes: [{ x: 0, y: 0, width: 100, height: 80 }] }));
    pick.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(pick).not.toHaveBeenCalled();
    await act(async () => {
      pick.mockImplementation(() => surface);
      overlay.remove();
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(setVideoLayout).toHaveBeenLastCalledWith(expect.objectContaining({ holes: [] }));
    unmount();
  });

  it("updates a resized overlay and stops observing when unmounted", async () => {
    const { unmount, pick } = await setup();
    const overlay = placed(document.createElement("div"), 0, 0, 100, 80);
    await act(async () => {
      pick.mockImplementation(() => overlay);
      document.body.append(overlay);
      await vi.advanceTimersByTimeAsync(600);
    });
    await act(async () => {
      placed(overlay, 0, 0, 150, 90);
      ResizeObserverStub.flush();
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(setVideoLayout).toHaveBeenLastCalledWith(expect.objectContaining({ holes: [{ x: 0, y: 0, width: 150, height: 90 }] }));
    unmount();
    pick.mockClear();
    setVideoLayout.mockClear();
    await act(async () => {
      overlay.style.display = "none";
      ResizeObserverStub.flush();
      window.dispatchEvent(new Event("pointerdown"));
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(pick).not.toHaveBeenCalled();
    expect(setVideoLayout).not.toHaveBeenCalled();
  });

  it("tracks CSS motion beyond the input window and returns to cached sampling afterwards", async () => {
    const { unmount, pick } = await setup();
    const overlay = placed(document.createElement("div"), 0, 0, 100, 80);
    const motionEvent = (type: string) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "animationName", { value: "slide" });
      overlay.dispatchEvent(event);
    };
    await act(async () => {
      pick.mockImplementation(() => overlay);
      document.body.append(overlay);
      motionEvent("animationstart");
      await vi.advanceTimersByTimeAsync(800);
      placed(overlay, 80, 0, 100, 80);
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(setVideoLayout).toHaveBeenLastCalledWith(expect.objectContaining({ holes: [{ x: 80, y: 0, width: 100, height: 80 }] }));
    await act(async () => {
      motionEvent("animationend");
      await vi.advanceTimersByTimeAsync(600);
    });
    pick.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(pick).not.toHaveBeenCalled();
    unmount();
  });
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

  // A fixed 5x5 grid sampled a 400x800 box every 75-200px and never saw anything smaller.
  it("should find a small overlay between the corners of a large feed", () => {
    const badge = placed(document.createElement("div"), 180, 380, 20, 20);
    document.body.appendChild(badge);
    topmostAt((x, y) => (x >= 180 && x <= 200 && y >= 380 && y <= 400 ? badge : surface));

    expect(coverings([BOX], CLIP, [surface, pip])).toEqual([{ x: 180, y: 380, width: 20, height: 20 }]);
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

describe("useNativeVideoLayout hiding the native feeds", () => {
  const box = () => document.createElement("div");

  // Hiding for every new box blanked both feeds for a frame on each flip and swap.
  it("should keep the feeds up when only the layout inputs change", () => {
    const props = { active: true, clipEl: box(), remoteEl: box(), localEl: box(), mirrorLocal: true };
    const { rerender } = renderHook((p) => useNativeVideoLayout(p), { initialProps: props });
    hideVideo.mockClear();

    rerender({ ...props, mirrorLocal: false });
    rerender({ ...props, remoteEl: props.localEl, localEl: props.remoteEl });

    expect(hideVideo).not.toHaveBeenCalled();
  });

  it("should hide the feeds when the call's video goes away, and on unmount", () => {
    const props = { active: true, clipEl: box(), remoteEl: box(), localEl: box(), mirrorLocal: true };
    const { rerender, unmount } = renderHook((p) => useNativeVideoLayout(p), { initialProps: props });
    hideVideo.mockClear();

    rerender({ ...props, active: false });
    expect(hideVideo).toHaveBeenCalled();

    rerender(props);
    hideVideo.mockClear();
    unmount();
    expect(hideVideo).toHaveBeenCalled();
  });
});
