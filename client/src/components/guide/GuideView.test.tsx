/** The guide conversation: its card points the way, and hiding it takes it away everywhere. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ showGuideStep: vi.fn(), setGuideHidden: vi.fn() }));

vi.mock("../../utils/guideActions", () => ({ showGuideStep: mocks.showGuideStep }));
vi.mock("../../api/guide", () => ({ getGuide: vi.fn(), setGuideHidden: mocks.setGuideHidden }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../stores/authStore", async () => {
  const { create } = await import("zustand");
  return {
    useAuthStore: create(() => ({
      user: { id: "u1", username: "alice", display_name: null, has_seen_download_prompt: true },
    })),
  };
});

import GuideView from "./GuideView";
import { useAuthStore } from "../../stores/authStore";
import { useGuideStore } from "../../stores/guideStore";
import { useUIStore } from "../../stores/uiStore";
import { GUIDE_TAB_ID } from "../../utils/guideScript";
import { GUIDE_TYPING_MAX_MS, GUIDE_FIRST_CARD_MS, GUIDE_CARD_MS } from "../../hooks/useGuideReveal";

const none = { community: false, message: false, voice: false, friend: false, profile: false, roles: false, app: false };

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  mocks.showGuideStep.mockReset();
  mocks.setGuideHidden.mockReset();
  useGuideStore.setState({ steps: none, hidden: false });
});

afterEach(() => {
  vi.useRealTimers();
});

function revealAll() {
  for (let i = 0; i < 20; i++) act(() => vi.advanceTimersByTime(GUIDE_TYPING_MAX_MS));
}

describe("the guide conversation", () => {
  it("types its greeting, then deals the step cards one by one", () => {
    render(<GuideView />);
    expect(screen.queryByText("community.title")).toBeNull();

    act(() => vi.advanceTimersByTime(GUIDE_TYPING_MAX_MS)); // greeting
    act(() => vi.advanceTimersByTime(GUIDE_TYPING_MAX_MS)); // intro
    expect(screen.queryByText("community.title")).toBeNull(); // still reading the intro
    act(() => vi.advanceTimersByTime(GUIDE_FIRST_CARD_MS)); // first card
    expect(screen.getByText("community.title")).toBeTruthy();
    expect(screen.queryByText("message.title")).toBeNull();
    act(() => vi.advanceTimersByTime(GUIDE_CARD_MS));
    expect(screen.getByText("message.title")).toBeTruthy();

    revealAll();

    for (const step of ["community", "message", "voice", "friend", "profile", "roles", "app"]) {
      expect(screen.getByText(`${step}.title`)).toBeTruthy();
    }
  });

  it("holds the greeting while the download prompt is in front, so it never plays unseen", () => {
    // A desktop browser that has not seen the prompt yet (jsdom reads as a desktop OS).
    const user = useAuthStore.getState().user;
    useAuthStore.setState({ user: { ...user, has_seen_download_prompt: false } } as never);
    render(<GuideView />);

    act(() => vi.advanceTimersByTime(GUIDE_TYPING_MAX_MS * 3));
    expect(screen.queryByText("greeting")).toBeNull();

    act(() => useAuthStore.setState({ user: { ...user, has_seen_download_prompt: true } } as never));
    act(() => vi.advanceTimersByTime(GUIDE_TYPING_MAX_MS));
    expect(screen.getByText("greeting")).toBeTruthy();
  });

  it("lets the user start with any step", () => {
    render(<GuideView />);
    revealAll();

    const voiceCard = screen.getByText("voice.title").closest(".guide-card") as HTMLElement;
    fireEvent.click(voiceCard.querySelector(".guide-card-btn") as HTMLElement);

    expect(mocks.showGuideStep).toHaveBeenCalledWith("voice");
  });

  it("shows a done step with its tick, not a button", () => {
    useGuideStore.setState({ steps: { ...none, community: true } });
    render(<GuideView />);
    revealAll();

    expect(screen.getByText("community.done")).toBeTruthy();
    expect(screen.getAllByText("showMe")).toHaveLength(5); // every other step but the app, which links to its download
  });

  it("hiding closes the guide tab once the server has stored it", async () => {
    mocks.setGuideHidden.mockResolvedValue({ success: true, data: { steps: none, hidden: true } });
    useUIStore.getState().openTab(GUIDE_TAB_ID, "guide", "guide");
    render(<GuideView />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("hide"));
    });

    const tabs = Object.values(useUIStore.getState().panels).flatMap((p) => p.tabs);
    expect(tabs.some((tb) => tb.channelId === GUIDE_TAB_ID)).toBe(false);
    expect(useGuideStore.getState().hidden).toBe(true);
  });

  it("keeps the guide open when the server refuses to hide it", async () => {
    mocks.setGuideHidden.mockResolvedValue({ success: false, error: "nope" });
    useUIStore.getState().openTab(GUIDE_TAB_ID, "guide", "guide");
    render(<GuideView />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("hide"));
    });

    const tabs = Object.values(useUIStore.getState().panels).flatMap((p) => p.tabs);
    expect(tabs.some((tb) => tb.channelId === GUIDE_TAB_ID)).toBe(true);
  });
});
