/** The guide re-asks the server only when the user may just have done a step not yet done. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const api = vi.hoisted(() => ({ getGuide: vi.fn(), setGuideHidden: vi.fn(), markGuideAppUsed: vi.fn() }));
vi.mock("../api/guide", () => api);

import { useGuideStore, GUIDE_REFRESH_DELAY_MS, GUIDE_RETRY_DELAY_MS } from "./guideStore";

const none = { community: false, message: false, voice: false, friend: false, profile: false, roles: false, app: false };

function serverSays(steps: Partial<typeof none>) {
  api.getGuide.mockResolvedValue({ success: true, data: { steps: { ...none, ...steps }, hidden: false } });
}

beforeEach(() => {
  vi.useFakeTimers();
  api.getGuide.mockReset();
  useGuideStore.getState().reset();
  useGuideStore.setState({ steps: none, hidden: false });
});

afterEach(() => {
  useGuideStore.getState().reset();
  vi.useRealTimers();
});

describe("refreshing guide progress", () => {
  it("turns a burst of events into one request", async () => {
    serverSays({ community: true });
    const { refreshFor } = useGuideStore.getState();
    refreshFor("community");
    refreshFor("community");
    refreshFor("community");

    await vi.advanceTimersByTimeAsync(GUIDE_REFRESH_DELAY_MS);

    expect(api.getGuide).toHaveBeenCalledTimes(1);
    expect(useGuideStore.getState().steps?.community).toBe(true);
  });

  it("looks once more when the server had not written it yet, and then stops", async () => {
    serverSays({});
    useGuideStore.getState().refreshFor("voice");

    await vi.advanceTimersByTimeAsync(GUIDE_REFRESH_DELAY_MS);
    serverSays({ voice: true });
    await vi.advanceTimersByTimeAsync(GUIDE_RETRY_DELAY_MS);
    expect(useGuideStore.getState().steps?.voice).toBe(true);

    await vi.advanceTimersByTimeAsync(GUIDE_RETRY_DELAY_MS * 3);
    expect(api.getGuide).toHaveBeenCalledTimes(2);
  });

  it("asks nothing for a step already done", async () => {
    useGuideStore.setState({ steps: { ...none, friend: true } });
    useGuideStore.getState().refreshFor("friend");
    await vi.advanceTimersByTimeAsync(GUIDE_REFRESH_DELAY_MS * 2);
    expect(api.getGuide).not.toHaveBeenCalled();
  });

  it("asks nothing while the guide is hidden or not loaded", async () => {
    useGuideStore.setState({ hidden: true });
    useGuideStore.getState().refreshFor("message");
    useGuideStore.setState({ hidden: false, steps: null });
    useGuideStore.getState().refreshFor("message");
    await vi.advanceTimersByTimeAsync(GUIDE_REFRESH_DELAY_MS * 2);
    expect(api.getGuide).not.toHaveBeenCalled();
  });

  it("drops what is pending on sign-out", async () => {
    serverSays({ message: true });
    useGuideStore.getState().refreshFor("message");
    useGuideStore.getState().reset();
    await vi.advanceTimersByTimeAsync(GUIDE_REFRESH_DELAY_MS * 2);
    expect(api.getGuide).not.toHaveBeenCalled();
  });

  it("ignores an answer that arrives after sign-out (it belongs to the previous account)", async () => {
    let answer: (v: unknown) => void = () => {};
    api.getGuide.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const loading = useGuideStore.getState().load();

    useGuideStore.getState().reset(); // signed out; the next account signs in
    answer({ success: true, data: { steps: { ...none, community: true }, hidden: false } });
    await loading;

    expect(useGuideStore.getState().steps).toBeNull();
  });

  it("does not let the previous account's timer clear the next account's pending check", async () => {
    let answerA: (v: unknown) => void = () => {};
    api.getGuide.mockReturnValueOnce(new Promise((resolve) => (answerA = resolve)));
    useGuideStore.getState().refreshFor("message");
    await vi.advanceTimersByTimeAsync(GUIDE_REFRESH_DELAY_MS); // A's request is out

    useGuideStore.getState().reset(); // A signs out, B signs in
    useGuideStore.setState({ steps: none, hidden: false });
    serverSays({});
    useGuideStore.getState().refreshFor("message"); // B's check is pending

    answerA({ success: true, data: { steps: none, hidden: false } });
    await vi.advanceTimersByTimeAsync(0);
    useGuideStore.getState().refreshFor("message"); // must still dedupe against B's pending check

    await vi.advanceTimersByTimeAsync(GUIDE_REFRESH_DELAY_MS + GUIDE_RETRY_DELAY_MS * 3);
    // A's request, then B's check and its one retry. A stale timer clearing B's entry would let
    // A's retry and B's retry both run: four.
    expect(api.getGuide).toHaveBeenCalledTimes(3);
  });
});

