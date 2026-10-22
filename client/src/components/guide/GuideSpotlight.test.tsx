/** The spotlight follows the user through a tour and only ends when the job is done or dropped. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string | string[]) => (Array.isArray(key) ? key[0] : key) }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import GuideSpotlight, { SPOTLIGHT_WAIT_MS, EXPLAIN_WAIT_MS, captionPosition } from "./GuideSpotlight";
import { useSpotlightStore } from "../../stores/spotlightStore";
import { useGuideStore } from "../../stores/guideStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { handleBack, pushBackHandler } from "../../utils/backStack";
import type { Tour } from "../../utils/guideTours";

const none = { community: false, message: false, voice: false, friend: false, profile: false, roles: false, app: false };

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
  useVoiceStore.setState({ currentVoiceChannelId: null });
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

  it("brings a control scrolled out of its list into view, once", () => {
    const friends = control("friends");
    const scrollIntoView = vi.fn();
    friends.scrollIntoView = scrollIntoView;
    start();
    frames(5);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
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

  it("ends on Android back before a panel opened during the tour", () => {
    start();
    frames();
    const closeSettings = vi.fn();
    const off = pushBackHandler(closeSettings); // the user opened settings on the way

    act(() => {
      handleBack();
    });
    expect(useSpotlightStore.getState().tour).toBeNull();
    expect(closeSettings).not.toHaveBeenCalled();

    act(() => {
      handleBack();
    });
    expect(closeSettings).toHaveBeenCalledTimes(1);
    off();
  });

  it("waits through a moment with nothing on screen, then gives up", () => {
    start();
    frames();
    expect(useSpotlightStore.getState().tour).not.toBeNull();

    act(() => vi.advanceTimersByTime(SPOTLIGHT_WAIT_MS + 100));
    expect(useSpotlightStore.getState().tour).toBeNull();
  });
});

describe("introducing the voice panel", () => {
  const voiceTour: Tour = {
    step: "voice",
    scope: "voice",
    stages: [{ target: "channel-voice", final: true }],
    explain: ["voice-mic", "voice-soundboard", "voice-disconnect"],
  };

  function joinVoice({ soundboard = true } = {}) {
    useVoiceStore.setState({ currentVoiceChannelId: "v1" });
    control("voice-panel");
    control("voice-mic");
    if (soundboard) control("voice-soundboard");
    control("voice-disconnect");
    frames();
  }

  it("starts once the user clicks the voice channel, and steps through with Next", () => {
    const channel = control("channel-voice");
    render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open(voiceTour));
    frames();

    fireEvent.pointerDown(channel);
    joinVoice();
    expect(screen.getByText("spotlight.voice.voice-mic")).toBeTruthy();

    fireEvent.click(screen.getByText("tourNext"));
    frames();
    expect(screen.getByText("spotlight.voice.voice-soundboard")).toBeTruthy();

    fireEvent.click(screen.getByText("tourNext"));
    frames();
    fireEvent.click(screen.getByText("tourDone"));
    expect(useSpotlightStore.getState().tour).toBeNull();
  });

  it("passes over a control this user does not have", () => {
    render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open({ ...voiceTour, stages: [] }));
    joinVoice({ soundboard: false });

    fireEvent.click(screen.getByText("tourNext"));
    frames(); // the soundboard stop finds no control and passes itself over
    frames(); // the next stop is drawn
    expect(screen.getByText("spotlight.voice.voice-disconnect")).toBeTruthy();
  });

  it("does not pass over controls still sliding in with the drawer", () => {
    render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open({ ...voiceTour, stages: [] }));
    useVoiceStore.setState({ currentVoiceChannelId: "v1" });
    // Mid-slide: the wide panel's right edge is on screen, the buttons on its left are not yet.
    const at = (el: HTMLElement, left: number, width: number) =>
      (el.getBoundingClientRect = () => ({ width, height: 32, top: 400, left, right: left + width, bottom: 432 }) as DOMRect);
    const panel = control("voice-panel");
    const mic = control("voice-mic");
    const sb = control("voice-soundboard");
    at(panel, -250, 300);
    at(mic, -240, 40);
    at(sb, -180, 40);
    frames();
    frames();

    at(panel, 10, 300);
    at(mic, 20, 40);
    at(sb, 80, 40);
    frames();
    expect(screen.getByText("spotlight.voice.voice-mic")).toBeTruthy();
  });

  it("still introduces the panel when the user got into voice another way", () => {
    control("channel-voice");
    render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open(voiceTour));
    frames();

    act(() => useGuideStore.setState({ steps: { ...none, voice: true } }));
    joinVoice();
    expect(screen.getByText("spotlight.voice.voice-mic")).toBeTruthy();
  });

  it("can be skipped", () => {
    render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open({ ...voiceTour, stages: [] }));
    joinVoice();

    fireEvent.click(screen.getByText("tourSkip"));
    expect(useSpotlightStore.getState().tour).toBeNull();
  });

  it("waits for voice to connect, but not forever", () => {
    render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open({ ...voiceTour, stages: [] }));
    act(() => vi.advanceTimersByTime(SPOTLIGHT_WAIT_MS * 2));
    expect(useSpotlightStore.getState().tour).not.toBeNull();

    act(() => vi.advanceTimersByTime(EXPLAIN_WAIT_MS));
    expect(useSpotlightStore.getState().tour).toBeNull();
  });

  it("does not start while the user is not actually in voice (a locked channel refused them)", () => {
    const channel = control("channel-voice");
    control("voice-mic"); // the microphone button is on screen in voice or not
    render(<GuideSpotlight />);
    act(() => useSpotlightStore.getState().open(voiceTour));
    frames();

    fireEvent.pointerDown(channel);
    frames();
    expect(screen.queryByText("spotlight.voice.voice-mic")).toBeNull();

    act(() => vi.advanceTimersByTime(EXPLAIN_WAIT_MS + 100));
    expect(useSpotlightStore.getState().tour).toBeNull();
  });
});

describe("where the caption goes", () => {
  const vw = 1280;
  const vh = 800;

  it("beside a control low on the screen, growing upwards from its bottom edge", () => {
    // The headphones button at the very bottom of the sidebar.
    const pos = captionPosition({ top: 740, left: 280, width: 120, height: 48 }, vw, vh);
    expect(pos.top).toBeUndefined();
    expect(pos.bottom).toBe(vh - (740 + 48));
    expect(pos.bottom as number).toBeGreaterThanOrEqual(8);
  });

  it("beside a control high on the screen, growing downwards", () => {
    const pos = captionPosition({ top: 60, left: 20, width: 200, height: 32 }, vw, vh);
    expect(pos).toMatchObject({ top: 60, left: 20 + 200 + 12 });
  });

  it("above a control near the bottom of a narrow screen, never past the edge", () => {
    const pos = captionPosition({ top: 700, left: 300, width: 60, height: 40 }, 360, 760);
    expect(pos.top).toBeUndefined();
    expect(pos.bottom as number).toBeGreaterThanOrEqual(8);
    expect(pos.left as number).toBeLessThanOrEqual(360 - 260 - 8);
  });
});

