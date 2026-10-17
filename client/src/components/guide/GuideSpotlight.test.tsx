/** The spotlight follows the user through a tour and only ends when the job is done or dropped. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string | string[]) => (Array.isArray(key) ? key[0] : key) }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import GuideSpotlight, { SPOTLIGHT_WAIT_MS } from "./GuideSpotlight";
import { useSpotlightStore } from "../../stores/spotlightStore";
import { useGuideStore } from "../../stores/guideStore";
import type { Tour } from "../../utils/guideTours";

const none = { community: false, message: false, dm: false, voice: false, friend: false, profile: false, roles: false, app: false };

const tour: Tour = {
  step: "friend",
  scope: "friend",
  stages: [{ target: "friends" }, { target: "add-friend-tab" }, { target: "add-friend-input", final: true }],
};

function control(tourName: string) {
  const el = document.createElement("button");
  el.dataset.tour = tourName;
  el.getBoundingClientRect = () => ({ width: 120, height: 32, top: 100, left: 10, right: 130, bottom: 132 }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const frames = (n = 3) => act(() => vi.advanceTimersByTime(16 * n));

function start() {
  render(<GuideSpotlight />);
  act(() => useSpotlightStore.getState().open(tour));
  frames();
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"] });
  useSpotlightStore.setState({ tour: null });
  useGuideStore.setState({ steps: none, hidden: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the spotlight", () => {
  it("moves on as the user opens each step of the way", () => {
    const friends = control("friends");
    start();
    expect(screen.getByText("spotlight.friend.friends")).toBeTruthy();

    fireEvent.pointerDown(friends); // not the last control: the tour goes on
    expect(useSpotlightStore.getState().tour).not.toBeNull();
    control("add-friend-tab"); // the user's click opened the Friends view
    frames();
    expect(screen.getByText("spotlight.friend.add-friend-tab")).toBeTruthy();
  });

  it("ends when the user uses the last control", () => {
    control("friends");
    const input = control("add-friend-input");
    start();

    fireEvent.pointerDown(input);
    expect(useSpotlightStore.getState().tour).toBeNull();
  });

  it("ends when the step gets done", () => {
    control("friends");
    start();
    act(() => useGuideStore.setState({ steps: { ...none, friend: true } }));
    expect(useSpotlightStore.getState().tour).toBeNull();
  });

  it("ends on a tap on the dim or Escape", () => {
    control("friends");
    start();
    fireEvent.pointerDown(document.querySelector(".guide-spot-dim") as Element);
    expect(useSpotlightStore.getState().tour).toBeNull();

    act(() => useSpotlightStore.getState().open(tour));
    frames();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useSpotlightStore.getState().tour).toBeNull();
  });

  it("waits through a moment with nothing on screen, then gives up", () => {
    start();
    frames();
    expect(useSpotlightStore.getState().tour).not.toBeNull();

    act(() => vi.advanceTimersByTime(SPOTLIGHT_WAIT_MS + 100));
    expect(useSpotlightStore.getState().tour).toBeNull();
  });
});
