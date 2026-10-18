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

describe("useBootRetry", () => {
  it("should retry on its own after the first backoff delay", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useBootRetry(retry));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(retry).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("should wait longer before each further attempt", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useBootRetry(retry));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000 + 3_999);
    });

    expect(retry).toHaveBeenCalledTimes(1);
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
    const { result } = renderHook(() => useBootRetry(retry));

    await act(async () => {
      result.current.retryNow();
      window.dispatchEvent(new Event("online"));
      result.current.retryNow();
    });
    expect(result.current.isRetrying).toBe(true);
    await act(async () => finish());

    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.isRetrying).toBe(false);
  });
});
