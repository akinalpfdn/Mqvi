/** Which fields the keyboard moves into view, how far, and whether they move with the keyboard. */
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

import { cubicBezier, initKeyboardScroll } from "./keyboardScroll";

const SCREEN = 800;
const KEYBOARD = 300;
const CLEARANCE = 12;
const ABOVE_KEYBOARD = SCREEN - KEYBOARD - CLEARANCE;
const CURVE = [0.38, 0.7, 0.125, 1] as const;

function fire(event: string, keyboardHeight = 0) {
  listeners.get(event)?.forEach((h) => h({ keyboardHeight }));
}

function setInnerHeight(value: number) {
  Object.defineProperty(window, "innerHeight", { value, configurable: true });
}

/** How far the app has shrunk above the keyboard; the CSS inset grows on the keyboard's curve. */
let insetAt: () => number = () => 0;

/** iOS: the keyboard starts moving now, and the inset follows it over 250 ms. */
function iosKeyboardStarts(height = KEYBOARD) {
  const started = performance.now();
  insetAt = () => height * cubicBezier(CURVE, Math.min(1, (performance.now() - started) / 250));
  fire("keyboardWillShow", height);
}

/**
 * A full-screen page of `contentHeight` px holding one focused field whose bottom sits
 * `fieldBottom` px into the content. Its scroll room grows as the app shrinks above the keyboard.
 */
function page(fieldBottom: number, contentHeight = 2000) {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  let scrollTop = 0;
  const clientHeight = () => window.innerHeight - insetAt();
  Object.defineProperty(scroller, "scrollHeight", { value: contentHeight });
  Object.defineProperty(scroller, "clientHeight", { get: clientHeight });
  Object.defineProperty(scroller, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, contentHeight - clientHeight()));
    },
  });
  scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;

  const field = document.createElement("input");
  field.getBoundingClientRect = () => ({ bottom: fieldBottom - scrollTop }) as DOMRect;
  scroller.appendChild(field);
  document.body.appendChild(scroller);
  field.focus();
  return { onScreenBottom: () => fieldBottom - scrollTop };
}

let stop: (() => void) | undefined;

async function start(platform: "android" | "ios") {
  listeners.clear();
  setInnerHeight(SCREEN);
  stop = await initKeyboardScroll(platform);
}

beforeEach(() => {
  document.body.innerHTML = "";
  insetAt = () => 0;
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout"] });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});

describe("iOS, where the app rises with the keyboard", () => {
  it("leaves a field near the top where it is", async () => {
    const field = page(120);
    await start("ios");
    iosKeyboardStarts();
    vi.advanceTimersByTime(300);
    fire("keyboardDidShow", KEYBOARD);

    expect(field.onScreenBottom()).toBe(120);
  });

  it("moves a field the keyboard would cover while the keyboard is still rising", async () => {
    const field = page(650);
    await start("ios");
    iosKeyboardStarts();

    vi.advanceTimersByTime(125);
    expect(field.onScreenBottom()).toBeLessThan(650);
    expect(field.onScreenBottom()).toBeGreaterThan(ABOVE_KEYBOARD);

    vi.advanceTimersByTime(175);
    expect(field.onScreenBottom()).toBe(ABOVE_KEYBOARD);
  });

  it("brings a field at the end of the page up as the page gains room, in one movement", async () => {
    // With no keyboard this page can scroll 200px; the field needs 462.
    const field = page(950, 1000);
    await start("ios");
    iosKeyboardStarts();

    const positions: number[] = [];
    for (let elapsed = 0; elapsed < 300; elapsed += 16) {
      vi.advanceTimersByTime(16);
      positions.push(field.onScreenBottom());
    }

    expect(field.onScreenBottom()).toBe(ABOVE_KEYBOARD);
    // Only ever upwards: no second movement after it settles.
    expect(positions.every((p, i) => i === 0 || p <= positions[i - 1])).toBe(true);
  });

  it("brings up a field on a page that only becomes scrollable as the keyboard rises", async () => {
    // A short form with room to spare below it: it can only scroll once the app has shrunk past
    // its end, two thirds into the keyboard's rise.
    const field = page(580, 600);
    await start("ios");
    iosKeyboardStarts();

    const positions: number[] = [];
    for (let elapsed = 0; elapsed < 250; elapsed += 16) {
      vi.advanceTimersByTime(16);
      positions.push(field.onScreenBottom());
    }
    vi.advanceTimersByTime(16);

    // Up with the keyboard, before keyboardDidShow — not in a second step after it.
    expect(field.onScreenBottom()).toBe(ABOVE_KEYBOARD);
    expect(positions.every((p, i) => i === 0 || p <= positions[i - 1])).toBe(true);
  });

  it("measures from the rotated screen", async () => {
    await start("ios");
    setInnerHeight(400);
    window.dispatchEvent(new Event("resize"));
    const field = page(300);

    iosKeyboardStarts(200);
    vi.advanceTimersByTime(300);

    expect(field.onScreenBottom()).toBe(400 - 200 - CLEARANCE);
  });
});

/** Android: MainActivity reports the keyboard as its animation starts and ends. */
function androidKeyboard(phase: "willShow" | "didShow" | "willHide" | "didHide", height = KEYBOARD, duration = 0) {
  window.dispatchEvent(new CustomEvent("mqvikeyboard", { detail: { phase, height, duration } }));
}

/** Android: the keyboard starts moving now, and the inset follows it over `duration` ms. */
function androidKeyboardStarts(height = KEYBOARD, duration = 300) {
  const started = performance.now();
  insetAt = () => height * cubicBezier(CURVE, Math.min(1, (performance.now() - started) / duration));
  androidKeyboard("willShow", height, duration);
}

describe("Android, from MainActivity's keyboard events", () => {
  it("leaves a field above the keyboard where it is", async () => {
    const field = page(120);
    await start("android");
    androidKeyboardStarts();
    vi.advanceTimersByTime(320);
    androidKeyboard("didShow");

    expect(field.onScreenBottom()).toBe(120);
  });

  it("moves a field the keyboard would cover while the keyboard is still rising", async () => {
    const field = page(650);
    await start("android");
    androidKeyboardStarts();

    vi.advanceTimersByTime(150);
    expect(field.onScreenBottom()).toBeLessThan(650);
    expect(field.onScreenBottom()).toBeGreaterThan(ABOVE_KEYBOARD);

    vi.advanceTimersByTime(170);
    expect(field.onScreenBottom()).toBe(ABOVE_KEYBOARD);
  });

  it("brings a short form up as the page gains room, before the keyboard has finished", async () => {
    const field = page(580, 600);
    await start("android");
    androidKeyboardStarts();

    vi.advanceTimersByTime(316);
    expect(field.onScreenBottom()).toBe(ABOVE_KEYBOARD);
  });

  it("stops listening once stopped", async () => {
    const field = page(650);
    await start("android");
    stop?.();
    stop = undefined;
    androidKeyboardStarts();
    vi.advanceTimersByTime(320);

    expect(field.onScreenBottom()).toBe(650);
  });
});

describe("the keyboard curve", () => {
  it("starts at 0, ends at 1 and never runs backwards", () => {
    const samples = Array.from({ length: 21 }, (_, i) => cubicBezier(CURVE, i / 20));
    expect(samples[0]).toBeCloseTo(0, 5);
    expect(samples[20]).toBeCloseTo(1, 5);
    expect(samples.every((v, i) => i === 0 || v >= samples[i - 1])).toBe(true);
  });
});
