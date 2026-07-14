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

type Listener = (s: { isActive: boolean }) => void;
const listeners: Record<string, Listener | undefined> = {};
let getStateImpl: () => Promise<{ isActive: boolean }>;

/** Stands in for the Java field BridgeActivity sets in onResume/onStop. */
let nativeIsActive = true;

vi.mock("@capacitor/app", () => ({
  App: {
    getState: () => getStateImpl(),
    addListener: (event: string, cb: Listener) => {
      listeners[event] = cb;
      return Promise.resolve({ remove: () => Promise.resolve() });
    },
  },
}));

/** The `appStateChange` listener, kept for the tests that still poke it directly. */
const listener = { get current() { return listeners["appStateChange"]; } };

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
  for (const k of Object.keys(listeners)) delete listeners[k];
  nativeIsActive = true;
  getStateImpl = () => Promise.resolve({ isActive: nativeIsActive });
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
    getStateImpl = () => Promise.resolve({ isActive: nativeIsActive });

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

  // An Android WebView does not reliably restore visibilityState (or fire visibilitychange) after
  // a resume. On native it carries no information the app state does not already carry.
  it("ignores a stale visibilityState after the app is resumed", async () => {
    setVisibility("hidden"); // the WebView never restored it
    setHasFocus(false);
    nativeIsActive = true;

    start();

    await vi.waitFor(() => expect(foreground()).toBe(true));
  });

  // ionic-team/capacitor-plugins#479, and the reason step 3 kept failing on the device.
  //
  // Android suspends the WebView's JS while the app is backgrounded, so the isActive:false that
  // BridgeActivity fires from onStop() cannot be delivered then — it is QUEUED. On resume it
  // arrives together with the isActive:true from onResume(), and it can arrive LAST. Trusting the
  // payload leaves the app permanently marked "backgrounded" while it is on screen: the DM is
  // never marked read, its badge never clears, its notification never leaves the tray.
  //
  // App.getState() reads the Java field BridgeActivity set synchronously, so it is right whatever
  // the events do.
  it("stays foregrounded when the queued isActive:false lands AFTER the resume", async () => {
    setVisibility("visible");
    setHasFocus(true);
    nativeIsActive = true; // BridgeActivity.onResume() already ran: the app IS active

    start();
    await vi.waitFor(() => expect(foreground()).toBe(true));

    // The backlog flushes: onResume's true, then onStop's stale false, out of order.
    listener.current?.({ isActive: true });
    listener.current?.({ isActive: false }); // stale — the app is NOT backgrounded

    await vi.waitFor(() => expect(foreground()).toBe(true));
  });

  // The wiring risk: without this, a DM left open while the app is backgrounded is never marked
  // read when the user comes back — nothing would re-run DMChat's effect.
  it("comes back to the foreground on resume", async () => {
    setVisibility("visible");
    setHasFocus(false);
    nativeIsActive = false;

    start();
    await vi.waitFor(() => expect(foreground()).toBe(false));

    nativeIsActive = true; // BridgeActivity.onResume()
    listeners["resume"]?.({ isActive: true });

    await vi.waitFor(() => expect(foreground()).toBe(true));
  });

  // onPause: a dialog, a picker or an incoming-call screen is on top. App.isActive is not false
  // until onStop, so asking would say "active" — but the user is not reading the conversation.
  it("leaves the foreground on pause, without asking", async () => {
    setVisibility("visible");
    setHasFocus(true);
    nativeIsActive = true;

    start();
    await vi.waitFor(() => expect(foreground()).toBe(true));

    listeners["pause"]?.({ isActive: false });

    expect(foreground()).toBe(false);
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
