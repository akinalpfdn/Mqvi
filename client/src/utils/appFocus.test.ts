/**
 * The DM read loop hangs off this signal, so a wrong answer is expensive in both directions:
 * a false negative means the phone buzzes for the chat on screen (the original complaint), and a
 * false positive means a notification is retracted for a message the user never saw.
 *
 * The specific hazard on Android: document.hasFocus() can report false while the app is in the
 * foreground. These tests pin down that native NEVER consults it.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

let capacitor = false;
vi.mock("./constants", () => ({ isCapacitor: () => capacitor }));

type StateListener = (s: { isActive: boolean }) => void;
let listener: StateListener | undefined;
let getStateImpl: () => Promise<{ isActive: boolean }>;

vi.mock("@capacitor/app", () => ({
  App: {
    getState: () => getStateImpl(),
    addListener: (_: string, cb: StateListener) => {
      listener = cb;
      return Promise.resolve({ remove: () => {} });
    },
  },
}));

import { initAppFocus } from "./appFocus";
import { useAppFocusStore } from "../stores/appFocusStore";

function setVisibility(value: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(value);
}
function setHasFocus(value: boolean) {
  vi.spyOn(document, "hasFocus").mockReturnValue(value);
}
const foreground = () => useAppFocusStore.getState().isForeground;

let dispose: (() => void) | undefined;
const start = () => {
  dispose = initAppFocus();
};

beforeEach(() => {
  vi.restoreAllMocks();
  listener = undefined;
  getStateImpl = () => Promise.resolve({ isActive: true });
  capacitor = false;
  useAppFocusStore.setState({ isForeground: null });
});

afterEach(() => {
  // Without this the listeners — and the native state they closed over — leak into the next test.
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
});

describe("web and Electron", () => {
  it("is in the foreground when the page is visible and focused", () => {
    setVisibility("visible");
    setHasFocus(true);

    start();

    expect(foreground()).toBe(true);
  });

  it("is not in the foreground when another window has focus", () => {
    setVisibility("visible");
    setHasFocus(false);

    start();

    expect(foreground()).toBe(false);
  });

  it("reacts to blur and focus", () => {
    setVisibility("visible");
    setHasFocus(true);
    start();

    setHasFocus(false);
    window.dispatchEvent(new Event("blur"));
    expect(foreground()).toBe(false);

    setHasFocus(true);
    window.dispatchEvent(new Event("focus"));
    expect(foreground()).toBe(true);
  });

  it("is not in the foreground when the tab is hidden", () => {
    setVisibility("hidden");
    setHasFocus(true);

    start();

    expect(foreground()).toBe(false);
  });
});

describe("Capacitor", () => {
  beforeEach(() => {
    capacitor = true;
  });

  // THE POINT OF THIS FILE. An Android WebView can report hasFocus() === false while the app is
  // in front. Consulting it there is what would leave the conversation on screen unread forever.
  it("ignores document.hasFocus() and trusts the native app state", async () => {
    setVisibility("visible");
    setHasFocus(false); // the WebView lying about focus
    getStateImpl = () => Promise.resolve({ isActive: true });

    start();
    await vi.waitFor(() => expect(foreground()).toBe(true));
  });

  it("is not in the foreground when the native app is backgrounded", async () => {
    setVisibility("visible");
    setHasFocus(true); // and the WebView lying the other way
    getStateImpl = () => Promise.resolve({ isActive: false });

    start();
    await vi.waitFor(() => expect(foreground()).toBe(false));
  });

  // Observed on device: after a background/resume cycle the Android WebView left
  // visibilityState at "hidden" and never fired visibilitychange, even though appStateChange
  // fired correctly (the WS reconnected and the messages arrived). Requiring "visible" meant the
  // app looked permanently backgrounded from then on: the DM on screen was never marked read,
  // its badge never cleared, and its notification stayed on the tray.
  it("ignores a stale visibilityState after the app is resumed", async () => {
    setVisibility("hidden"); // the WebView never restored it
    setHasFocus(false);
    getStateImpl = () => Promise.resolve({ isActive: false });

    start();
    await vi.waitFor(() => expect(foreground()).toBe(false));

    listener?.({ isActive: true }); // resumed — this is the only signal that tells the truth

    expect(foreground()).toBe(true);
  });

  // The wiring risk: without this, a DM left open while the app is backgrounded is never marked
  // read when the user comes back — nothing would re-run DMChat's effect.
  it("updates when the app is resumed", async () => {
    setVisibility("visible");
    setHasFocus(false);
    getStateImpl = () => Promise.resolve({ isActive: false });

    start();
    await vi.waitFor(() => expect(foreground()).toBe(false));

    listener?.({ isActive: true });

    expect(foreground()).toBe(true);
  });

  // The cold-start race: App.getState() is async. Until it answers we know nothing, and "unknown"
  // must not be read as "the user is looking at it" — that would suppress a real notification.
  it("is unknown, not true, until the native state answers", () => {
    setVisibility("visible");
    setHasFocus(true);
    getStateImpl = () => new Promise(() => {}); // never resolves

    start();

    expect(foreground()).toBeNull();
  });

  // If the native state cannot be read at all, sitting at null forever would mean nothing is ever
  // marked read. Fall back to the web signal rather than deadlock.
  it("falls back to the web signal when the native state cannot be read", async () => {
    setVisibility("visible");
    setHasFocus(true);
    getStateImpl = () => Promise.reject(new Error("plugin unavailable"));

    start();

    await vi.waitFor(() => expect(foreground()).toBe(true));
  });
});
