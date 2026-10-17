/** Which fields the keyboard moves into view, by how much, and in how many movements. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Handler = (info: { keyboardHeight: number }) => void;
const listeners = vi.hoisted(() => new Map<string, Handler[]>());

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: {
    addListener: vi.fn(async (event: string, handler: Handler) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return { remove: vi.fn() };
    }),
  },
}));

const SCREEN = 800;
const KEYBOARD = 300;
const CLEARANCE = 12;

function fire(event: string, keyboardHeight = 0) {
  listeners.get(event)?.forEach((h) => h({ keyboardHeight }));
}

function setInnerHeight(value: number) {
  Object.defineProperty(window, "innerHeight", { value, configurable: true });
}

/**
 * A full-screen page of `contentHeight` px that scrolls, holding one focused field whose bottom
 * sits `fieldBottom` px into the content. The page fills the WebView, so it can scroll further
 * once the WebView shrinks — exactly what iOS does 0.2 s after the keyboard is up.
 */
function page(fieldBottom: number, contentHeight = 1000) {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  let scrollTop = 0;
  Object.defineProperty(scroller, "scrollTop", { get: () => scrollTop });
  Object.defineProperty(scroller, "scrollHeight", { value: contentHeight });
  Object.defineProperty(scroller, "clientHeight", { get: () => window.innerHeight });
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  const scrollTo = vi.fn(({ top }: { top: number }) => {
    scrollTop = Math.min(top, contentHeight - window.innerHeight);
  });
  scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;

  const field = document.createElement("input");
  field.getBoundingClientRect = () => ({ bottom: fieldBottom - scrollTop }) as DOMRect;
  scroller.appendChild(field);
  document.body.appendChild(scroller);
  field.focus();
  return { scrollTo, onScreenBottom: () => fieldBottom - scrollTop };
}

let stop: (() => void) | undefined;

async function start(platform: "android" | "ios") {
  listeners.clear();
  setInnerHeight(SCREEN);
  const { initKeyboardScroll } = await import("./keyboardScroll");
  stop = await initKeyboardScroll(platform);
}

function shrinkWebView() {
  setInnerHeight(SCREEN - KEYBOARD);
  window.dispatchEvent(new Event("resize"));
}

const ABOVE_KEYBOARD = SCREEN - KEYBOARD - CLEARANCE;

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers();
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

describe("iOS, where the web view shrinks 0.2 s after the keyboard is up", () => {
  it("leaves a field near the top where it is", async () => {
    const field = page(120);
    await start("ios");
    fire("keyboardWillShow", KEYBOARD);
    fire("keyboardDidShow", KEYBOARD);
    shrinkWebView();
    expect(field.scrollTo).not.toHaveBeenCalled();
  });

  it("moves a field with room to scroll once, and does not move it again when the view shrinks", async () => {
    const field = page(650, 2000);
    await start("ios");
    fire("keyboardWillShow", KEYBOARD);
    fire("keyboardDidShow", KEYBOARD);
    shrinkWebView();

    expect(field.scrollTo).toHaveBeenCalledTimes(1);
    expect(field.onScreenBottom()).toBe(ABOVE_KEYBOARD);
  });

  it("moves a field near the end of the page once, after the view has shrunk", async () => {
    // Before the shrink this page can scroll only 200px; the field needs 362.
    const field = page(950, 1000);
    await start("ios");
    fire("keyboardWillShow", KEYBOARD);
    fire("keyboardDidShow", KEYBOARD);
    expect(field.scrollTo).not.toHaveBeenCalled();

    shrinkWebView();

    expect(field.scrollTo).toHaveBeenCalledTimes(1);
    expect(field.onScreenBottom()).toBe(ABOVE_KEYBOARD);
  });

  it("still moves the field as far as it can when the view never shrinks", async () => {
    const field = page(950, 1000);
    await start("ios");
    fire("keyboardWillShow", KEYBOARD);
    fire("keyboardDidShow", KEYBOARD);

    vi.advanceTimersByTime(500);

    expect(field.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("measures the keyboard from the right full height after a rotation", async () => {
    await start("ios");
    setInnerHeight(400); // landscape, no keyboard
    window.dispatchEvent(new Event("resize"));
    const field = page(300, 2000);

    fire("keyboardWillShow", 200);
    fire("keyboardDidShow", 200);

    expect(field.onScreenBottom()).toBe(400 - 200 - CLEARANCE);
  });
});

describe("Android, where the keyboard covers the web view", () => {
  it("leaves a field above the keyboard where it is", async () => {
    const field = page(120);
    await start("android");
    fire("keyboardDidShow", KEYBOARD);
    expect(field.scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls a field under the keyboard just into view", async () => {
    const field = page(650, 2000);
    await start("android");
    fire("keyboardDidShow", KEYBOARD);
    expect(field.onScreenBottom()).toBe(ABOVE_KEYBOARD);
  });
});
