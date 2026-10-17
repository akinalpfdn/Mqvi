/** The guide re-asks the server only when the user may just have done a step not yet done. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const api = vi.hoisted(() => ({ getGuide: vi.fn(), setGuideHidden: vi.fn(), markGuideAppUsed: vi.fn() }));
vi.mock("../api/guide", () => api);

import { useGuideStore, GUIDE_REFRESH_DELAY_MS, GUIDE_RETRY_DELAY_MS } from "./guideStore";

const none = { community: false, message: false, dm: false, voice: false, friend: false, profile: false, roles: false, app: false };

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
});
