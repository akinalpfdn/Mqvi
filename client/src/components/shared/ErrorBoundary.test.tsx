/**
 * The boundary reloads on a crash, which is right for a transient one and catastrophic for a
 * deterministic one: the same render throws again and reloads again, and the user has no way out.
 * These tests pin the bound and the escape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("../../i18n", () => ({ default: { t: (key: string) => key } }));

import ErrorBoundary from "./ErrorBoundary";

const RELOAD_COUNT_KEY = "mqvi:error-boundary-reloads";

function Boom(): never {
  throw new Error("deterministic poison");
}

function Fine() {
  return <div>fine</div>;
}

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  // React logs the caught error; silence it so a passing run reads clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
  reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("should reload once for a first crash", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByText("common:errorReloading")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("should stop reloading and offer a way out once the budget is spent", () => {
    // Three reloads already went into this error; the app came back and threw again.
    sessionStorage.setItem(RELOAD_COUNT_KEY, "3");

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("common:errorPersistent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "common:errorRetry" })).toBeTruthy();
  });

  it("should count each crash so a loop actually terminates", () => {
    sessionStorage.setItem(RELOAD_COUNT_KEY, "1");

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(sessionStorage.getItem(RELOAD_COUNT_KEY)).toBe("2");
  });

  it("should forget the count once the app has rendered for a while", () => {
    sessionStorage.setItem(RELOAD_COUNT_KEY, "2");

    render(
      <ErrorBoundary>
        <Fine />
      </ErrorBoundary>
    );

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    // Otherwise an unrelated crash weeks later inherits a spent budget and never gets its retries.
    expect(sessionStorage.getItem(RELOAD_COUNT_KEY)).toBeNull();
  });

  it("should not auto-reload when the count cannot be persisted", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    // Fail closed: with no way to count reloads there is no way to bound them, and an unbounded
    // loop is worse than an error screen.
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText("common:errorPersistent")).toBeTruthy();
  });

  it("should clear the count when the user retries by hand", () => {
    sessionStorage.setItem(RELOAD_COUNT_KEY, "3");

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    act(() => {
      screen.getByRole("button", { name: "common:errorRetry" }).click();
    });

    expect(sessionStorage.getItem(RELOAD_COUNT_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
