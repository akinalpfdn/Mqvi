/** Back closes the top-most layer; an overlay sits above every layer, even ones opened after it. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { BackPriority, handleBack, pushBackHandler } from "./backStack";

const cleanups: (() => void)[] = [];
const push = (handler: () => void, priority?: number) => cleanups.push(pushBackHandler(handler, priority));

afterEach(() => {
  cleanups.splice(0).forEach((off) => off());
});

describe("back stack", () => {
  it("reports nothing open when empty", () => {
    expect(handleBack()).toBe(false);
  });

  it("closes the most recent layer first", () => {
    const first = vi.fn();
    const second = vi.fn();
    push(first);
    push(second);

    handleBack();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    handleBack();
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("closes an overlay before a layer opened after it", () => {
    const overlay = vi.fn();
    const settings = vi.fn();
    push(overlay, BackPriority.Overlay);
    push(settings);

    handleBack();
    expect(overlay).toHaveBeenCalledTimes(1);
    expect(settings).not.toHaveBeenCalled();

    handleBack();
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("forgets a layer that closed on its own", () => {
    const layer = vi.fn();
    const off = pushBackHandler(layer);
    off();

    expect(handleBack()).toBe(false);
    expect(layer).not.toHaveBeenCalled();
  });
});
