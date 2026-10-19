import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBootRetry } from "./useBootRetry";
import { useAppFocusStore } from "../stores/appFocusStore";

beforeEach(() => {
  vi.useFakeTimers();
  useAppFocusStore.setState({ isForeground: false });
});

afterEach(() => {
  vi.useRealTimers();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useBootRetry", () => {
  it("should retry after 1s, 1s, 2s, 2s, 2s, 3s, 5s, 7s, 10s, then every 15s", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useBootRetry(retry));

    const schedule = [1, 1, 2, 2, 2, 3, 5, 7, 10, 15, 15];
    for (const [i, seconds] of schedule.entries()) {
      await advance(seconds * 1_000 - 1);
      expect(retry).toHaveBeenCalledTimes(i);
      await advance(1);
      expect(retry).toHaveBeenCalledTimes(i + 1);
    }
  });

  it("should retry at once when the network comes back", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useBootRetry(retry));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("should retry at once when the app returns to the foreground", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useBootRetry(retry));

    await act(async () => {
      useAppFocusStore.setState({ isForeground: true });
    });

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("should not start a second attempt while one is running", async () => {
    let finish: () => void = () => {};
    const retry = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    renderHook(() => useBootRetry(retry));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
    });
    await advance(30_000);
    await act(async () => finish());

    expect(retry).toHaveBeenCalledTimes(1);
  });
});
