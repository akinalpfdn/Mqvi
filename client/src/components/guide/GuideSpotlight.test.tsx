/** The spotlight points at a real control, leaves it usable, and gets out of the way. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

const media = vi.hoisted(() => ({ mobile: false }));
vi.mock("../../hooks/useMediaQuery", () => ({ useIsMobile: () => media.mobile }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import GuideSpotlight, { SPOTLIGHT_WAIT_MS } from "./GuideSpotlight";
import { useSpotlightStore } from "../../stores/spotlightStore";
import { useMobileStore } from "../../stores/mobileStore";

function target(tour: string) {
  const el = document.createElement("button");
  el.dataset.tour = tour;
  el.getBoundingClientRect = () => ({ width: 120, height: 32, top: 100, left: 10, right: 130, bottom: 132 }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const frames = (n = 3) => act(() => vi.advanceTimersByTime(16 * n));

beforeEach(() => {
  document.body.innerHTML = "";
  media.mobile = false;
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"] });
  useSpotlightStore.setState({ request: null });
  useMobileStore.setState({ leftDrawerOpen: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the spotlight", () => {
  it("points at the control with the step's caption", () => {
    target("discover");
    render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open("community", ["discover"]));
    frames();

    expect(screen.getByText("spotlight.community")).toBeTruthy();
  });

  it("waits for a control that is still appearing", () => {
    render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open("community", ["discover"]));
    frames();
    target("discover"); // the drawer finished sliding in
    frames();

    expect(screen.getByText("spotlight.community")).toBeTruthy();
  });

  it("gives up when the control never appears", () => {
    render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open("friend", ["friends"]));
    act(() => vi.advanceTimersByTime(SPOTLIGHT_WAIT_MS + 100));

    expect(useSpotlightStore.getState().request).toBeNull();
  });

  it("ends when the user uses the control", () => {
    const el = target("discover");
    render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open("community", ["discover"]));
    frames();

    fireEvent.pointerDown(el);
    expect(useSpotlightStore.getState().request).toBeNull();
  });

  it("ends on a tap elsewhere or Escape", () => {
    target("discover");
    const { container } = render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open("community", ["discover"]));
    frames();
    fireEvent.pointerDown(document.querySelector(".guide-spot-dim") as Element);
    expect(useSpotlightStore.getState().request).toBeNull();

    act(() => useSpotlightStore.getState().open("community", ["discover"]));
    frames();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useSpotlightStore.getState().request).toBeNull();
    expect(container).toBeTruthy();
  });

  it("ends when the mobile drawer it points into closes", () => {
    media.mobile = true;
    useMobileStore.setState({ leftDrawerOpen: true });
    target("friends");
    render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open("friend", ["friends"]));
    frames();

    act(() => useMobileStore.setState({ leftDrawerOpen: false }));
    expect(useSpotlightStore.getState().request).toBeNull();
  });
});
