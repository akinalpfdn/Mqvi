/** The store review request: when the hook asks, and when it holds back. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const env = vi.hoisted(() => ({
  capacitor: true,
  listeners: {} as Record<string, () => void>,
}));

vi.mock("../utils/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/constants")>()),
  isCapacitor: () => env.capacitor,
}));
vi.mock("@capacitor/app", () => ({
  App: {
    getInfo: vi.fn(async () => ({ version: "1.1.0" })),
    addListener: vi.fn(async (event: string, cb: () => void) => {
      env.listeners[event] = cb;
      return { remove: vi.fn() };
    }),
  },
}));
vi.mock("@capawesome/capacitor-app-review", () => ({
  AppReview: { requestReview: vi.fn(async () => undefined) },
}));

import { AppReview } from "@capawesome/capacitor-app-review";
import { useVoiceStore } from "../stores/voiceStore";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { REVIEW_DELAY_MS, useReviewPrompt } from "./useReviewPrompt";
import { NEW_OPEN_AFTER_MS } from "../utils/reviewPrompt";

const START = 1_800_000_000_000;

/** Nine opens already counted, the last one long ago: the next arrival is the 10th open. */
function seedNineOpens() {
  localStorage.setItem("mqvi_review", JSON.stringify({ version: "1.1.0", opens: 9, asked: false, lastSeenAt: START - 2 * NEW_OPEN_AFTER_MS }));
}
const stored = () => JSON.parse(localStorage.getItem("mqvi_review") ?? "null");
const flush = () => act(async () => {});

beforeEach(() => {
  env.capacitor = true;
  env.listeners = {};
  localStorage.clear();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(START);
  useVoiceStore.setState({ currentVoiceChannelId: null });
  useP2PCallStore.setState({ activeCall: null, incomingCall: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useReviewPrompt", () => {
  it("asks a few seconds into the 10th open, and only once", async () => {
    seedNineOpens();
    renderHook(() => useReviewPrompt());
    await flush();
    expect(AppReview.requestReview).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(REVIEW_DELAY_MS));
    expect(AppReview.requestReview).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({ opens: 10, asked: true });

    vi.setSystemTime(START + 2 * NEW_OPEN_AFTER_MS);
    await act(async () => env.listeners.resume());
    await act(async () => vi.advanceTimersByTime(REVIEW_DELAY_MS));
    expect(AppReview.requestReview).toHaveBeenCalledTimes(1);
  });

  it("holds back during a voice channel and asks on the next open", async () => {
    seedNineOpens();
    useVoiceStore.setState({ currentVoiceChannelId: "v1" });
    renderHook(() => useReviewPrompt());
    await flush();
    await act(async () => vi.advanceTimersByTime(REVIEW_DELAY_MS));
    expect(AppReview.requestReview).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ asked: false });

    useVoiceStore.setState({ currentVoiceChannelId: null });
    await act(async () => env.listeners.pause());
    vi.setSystemTime(START + 2 * NEW_OPEN_AFTER_MS);
    await act(async () => env.listeners.resume());
    await act(async () => vi.advanceTimersByTime(REVIEW_DELAY_MS));
    expect(AppReview.requestReview).toHaveBeenCalledTimes(1);
  });

  it("holds back during a call", async () => {
    seedNineOpens();
    useP2PCallStore.setState({ activeCall: { id: "c1" } as never });
    renderHook(() => useReviewPrompt());
    await flush();
    await act(async () => vi.advanceTimersByTime(REVIEW_DELAY_MS));
    expect(AppReview.requestReview).not.toHaveBeenCalled();
  });

  it("does not count a quick switch away and back as an open", async () => {
    localStorage.setItem("mqvi_review", JSON.stringify({ version: "1.1.0", opens: 5, asked: false, lastSeenAt: START - 2 * NEW_OPEN_AFTER_MS }));
    renderHook(() => useReviewPrompt());
    await flush();
    expect(stored().opens).toBe(6);

    await act(async () => env.listeners.pause());
    vi.setSystemTime(START + 60_000);
    await act(async () => env.listeners.resume());
    expect(stored().opens).toBe(6);
  });

  it("drops a pending request when the app goes to the background", async () => {
    seedNineOpens();
    renderHook(() => useReviewPrompt());
    await flush();
    await act(async () => env.listeners.pause());
    await act(async () => vi.advanceTimersByTime(REVIEW_DELAY_MS));
    expect(AppReview.requestReview).not.toHaveBeenCalled();
  });

  it("does nothing outside the mobile apps", async () => {
    env.capacitor = false;
    seedNineOpens();
    renderHook(() => useReviewPrompt());
    await flush();
    await act(async () => vi.advanceTimersByTime(REVIEW_DELAY_MS));
    expect(AppReview.requestReview).not.toHaveBeenCalled();
    expect(stored().opens).toBe(9);
  });
});
