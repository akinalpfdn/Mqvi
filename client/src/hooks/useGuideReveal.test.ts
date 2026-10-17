/** The guide types new lines one by one and shows lines already seen at once. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

import { useGuideReveal, GUIDE_TYPING_MS } from "./useGuideReveal";

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("revealing the guide's lines", () => {
  it("types each new line after a beat", () => {
    const { result } = renderHook(() => useGuideReveal(["a", "b"], "u1"));
    expect(result.current).toEqual({ visible: 0, typing: true });

    act(() => vi.advanceTimersByTime(GUIDE_TYPING_MS));
    expect(result.current).toEqual({ visible: 1, typing: true });

    act(() => vi.advanceTimersByTime(GUIDE_TYPING_MS));
    expect(result.current).toEqual({ visible: 2, typing: false });
  });

  it("shows lines already seen on this device at once, and types only the new one", () => {
    localStorage.setItem("mqvi_guide_seen:u1", JSON.stringify(["a", "b"]));
    const { result } = renderHook(() => useGuideReveal(["a", "b", "c"], "u1"));
    expect(result.current).toEqual({ visible: 2, typing: true });
  });

  it("types a line that appears later, after progress", () => {
    localStorage.setItem("mqvi_guide_seen:u1", JSON.stringify(["a"]));
    const { result, rerender } = renderHook(({ ids }) => useGuideReveal(ids, "u1"), {
      initialProps: { ids: ["a"] },
    });
    expect(result.current).toEqual({ visible: 1, typing: false });

    rerender({ ids: ["a", "b"] });
    expect(result.current.typing).toBe(true);
    act(() => vi.advanceTimersByTime(GUIDE_TYPING_MS));
    expect(result.current).toEqual({ visible: 2, typing: false });
  });

  it("keeps each account's seen lines apart", () => {
    localStorage.setItem("mqvi_guide_seen:u1", JSON.stringify(["a"]));
    const { result } = renderHook(() => useGuideReveal(["a"], "u2"));
    expect(result.current.typing).toBe(true);
  });
});
