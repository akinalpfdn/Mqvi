/** The guide conversation: its card points the way, and hiding it takes it away everywhere. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ showGuideStep: vi.fn(), setGuideHidden: vi.fn() }));

vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => false }));
vi.mock("../../utils/guideActions", () => ({ showGuideStep: mocks.showGuideStep }));
vi.mock("../../api/guide", () => ({ getGuide: vi.fn(), setGuideHidden: mocks.setGuideHidden }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../stores/authStore", async () => {
  const { create } = await import("zustand");
  return { useAuthStore: create(() => ({ user: { id: "u1", username: "alice", display_name: null } })) };
});

import GuideView from "./GuideView";
import { useGuideStore } from "../../stores/guideStore";
import { useUIStore } from "../../stores/uiStore";
import { GUIDE_TAB_ID } from "../../utils/guideScript";
import { GUIDE_TYPING_MS } from "../../hooks/useGuideReveal";

const none = { community: false, message: false, dm: false, voice: false, friend: false, profile: false, roles: false, app: false };

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
  for (let i = 0; i < 10; i++) act(() => vi.advanceTimersByTime(GUIDE_TYPING_MS));
}

describe("the guide conversation", () => {
  it("types its greeting, then offers every step together", () => {
    render(<GuideView />);
    expect(screen.queryByText("community.title")).toBeNull();

    revealAll();

    for (const step of ["community", "message", "dm", "voice", "friend", "profile", "roles", "app"]) {
      expect(screen.getByText(`${step}.title`)).toBeTruthy();
    }
  });

  it("lets the user start with any step", () => {
    render(<GuideView />);
    revealAll();

    const voiceCard = screen.getByText("voice.title").closest(".guide-card") as HTMLElement;
    fireEvent.click(voiceCard.querySelector(".guide-card-btn") as HTMLElement);

    expect(mocks.showGuideStep).toHaveBeenCalledWith("voice", expect.any(Boolean));
  });

  it("shows a done step with its tick, not a button", () => {
    useGuideStore.setState({ steps: { ...none, community: true } });
    render(<GuideView />);
    revealAll();

    expect(screen.getByText("community.done")).toBeTruthy();
    expect(screen.getAllByText("showMe")).toHaveLength(7); // every other step
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
