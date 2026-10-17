/** The guide types its lines, deals its cards one by one, and waits while it cannot be seen. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useGuideReveal, GUIDE_TYPING_MS, GUIDE_CARD_MS } from "./useGuideReveal";

const line = (id: string) => ({ id, typed: true });
const card = (id: string) => ({ id, typed: false });

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("revealing the guide", () => {
  it("types a line behind a beat, then deals each card on its own", () => {
    const items = [line("hi"), card("c1"), card("c2")];
    const { result } = renderHook(() => useGuideReveal(items, "u1"));
    expect(result.current).toEqual({ visible: 0, typing: true });

    act(() => vi.advanceTimersByTime(GUIDE_TYPING_MS));
    expect(result.current).toEqual({ visible: 1, typing: false }); // no typing dots for a card

    act(() => vi.advanceTimersByTime(GUIDE_CARD_MS));
    expect(result.current.visible).toBe(2);
    act(() => vi.advanceTimersByTime(GUIDE_CARD_MS));
    expect(result.current.visible).toBe(3);
  });

  it("waits while paused (a dialog in front) and carries on after", () => {
    const items = [line("hi")];
    const { result, rerender } = renderHook(({ paused }) => useGuideReveal(items, "u1", paused), {
      initialProps: { paused: true },
    });
    act(() => vi.advanceTimersByTime(GUIDE_TYPING_MS * 5));
    expect(result.current).toEqual({ visible: 0, typing: false });

    rerender({ paused: false });
    expect(result.current.typing).toBe(true);
    act(() => vi.advanceTimersByTime(GUIDE_TYPING_MS));
    expect(result.current.visible).toBe(1);
  });

  it("shows what was already seen on this device at once", () => {
    localStorage.setItem("mqvi_guide_seen:u1", JSON.stringify(["hi", "c1"]));
    const { result } = renderHook(() => useGuideReveal([line("hi"), card("c1"), card("c2")], "u1"));
    expect(result.current.visible).toBe(2);
  });

  it("keeps each account's seen items apart", () => {
    localStorage.setItem("mqvi_guide_seen:u1", JSON.stringify(["hi"]));
    const { result } = renderHook(() => useGuideReveal([line("hi")], "u2"));
    expect(result.current.visible).toBe(0);
  });
});
