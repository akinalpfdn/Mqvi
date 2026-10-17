/** The iOS keyboard reaches the CSS inset the whole app shrinks by. */
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

import { initIosKeyboardInset } from "./iosKeyboardInset";

const fire = (event: string, keyboardHeight = 0) =>
  listeners.get(event)?.forEach((h) => h({ keyboardHeight }));
const inset = () => document.documentElement.style.getPropertyValue("--keyboard-inset");
const lift = () => document.documentElement.style.getPropertyValue("--keyboard-lift");
const lifting = () => document.documentElement.classList.contains("keyboard-lifting");

let stop: (() => void) | undefined;

/** A phone whose home indicator takes `safeBottom` px; jsdom has no env(). */
async function start(safeBottom: number) {
  listeners.clear();
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el) =>
    // The safe-area probe; jsdom drops its env() padding, so it is known by its other styles.
    el instanceof HTMLElement && el.style.visibility === "hidden" && el.style.position === "fixed"
      ? ({ paddingBottom: `${safeBottom}px` } as CSSStyleDeclaration)
      : real(el),
  );
  stop = await initIosKeyboardInset();
}

beforeEach(() => {
  document.documentElement.removeAttribute("style");
  document.body.innerHTML = "";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** A chat column: a message list scrolled to `scrollTop`, and a focused composer. */
function chat(scrollTop: number, column = "chat-area") {
  const area = document.createElement("div");
  area.className = column;
  const list = document.createElement("div");
  list.className = "messages-scroll";
  let top = scrollTop;
  Object.defineProperty(list, "scrollTop", { get: () => top, set: (v: number) => (top = v) });
  const composer = document.createElement("textarea");
  area.append(list, composer);
  document.body.appendChild(area);
  composer.focus();
  return { scrollTop: () => top };
}

describe("the iOS keyboard inset", () => {
  it("is the keyboard less the home indicator it already covers, set as the keyboard starts", async () => {
    await start(34);
    fire("keyboardWillShow", 336);
    expect(inset()).toBe("302px");
  });

  it("is the whole keyboard on a phone without a home indicator", async () => {
    await start(0);
    fire("keyboardWillShow", 260);
    expect(inset()).toBe("260px");
  });

  it("never goes below zero (an iPad keyboard that does not overlap the app)", async () => {
    await start(20);
    fire("keyboardWillShow", 0);
    expect(inset()).toBe("0px");
  });

  it("goes back to zero as the keyboard starts to hide", async () => {
    await start(34);
    fire("keyboardWillShow", 336);
    fire("keyboardWillHide");
    expect(inset()).toBe("0px");
  });

  it("animates only while it runs", async () => {
    await start(0);
    expect(document.documentElement.classList.contains("keyboard-animated")).toBe(true);
    stop?.();
    stop = undefined;
    expect(document.documentElement.classList.contains("keyboard-animated")).toBe(false);
  });
});

describe("the chat, which moves by translation instead of re-laying out each frame", () => {
  it("rises by translation, then hands over to the layout once the keyboard is up", async () => {
    chat(400);
    await start(0);
    fire("keyboardWillShow", 300);

    expect(["", "0px"]).toContain(inset()); // the layout has not moved yet
    expect(lift()).toBe("300px");
    expect(lifting()).toBe(true);

    vi.advanceTimersByTime(250);
    expect(inset()).toBe("300px");
    expect(lift()).toBe("0px");
    expect(lifting()).toBe(false);
  });

  it("keeps the messages where they are on screen when the layout takes over", async () => {
    const list = chat(400);
    await start(0);
    fire("keyboardWillShow", 300);
    vi.advanceTimersByTime(250);
    // The list lost 300px of height, so it scrolled 300px further to show the same messages.
    expect(list.scrollTop()).toBe(700);
  });

  it("falls with the layout grown at once and the chat translated down from where it was", async () => {
    const list = chat(400);
    await start(0);
    fire("keyboardWillShow", 300);
    vi.advanceTimersByTime(250);

    fire("keyboardWillHide");
    expect(inset()).toBe("0px");
    expect(list.scrollTop()).toBe(400);
    expect(lifting()).toBe(true);

    vi.advanceTimersByTime(250);
    expect(lift()).toBe("0px");
    expect(lifting()).toBe(false);
  });

  it("finishes a rise still in flight before falling", async () => {
    chat(400);
    await start(0);
    fire("keyboardWillShow", 300);
    vi.advanceTimersByTime(100);
    fire("keyboardWillHide");

    expect(inset()).toBe("0px");
    vi.advanceTimersByTime(250);
    expect(lift()).toBe("0px");
  });

  it("follows a taller keyboard (emoji) while open, still by translation", async () => {
    chat(400);
    await start(0);
    fire("keyboardWillShow", 300);
    vi.advanceTimersByTime(250);

    fire("keyboardWillShow", 360);
    expect(lift()).toBe("60px");
    vi.advanceTimersByTime(250);
    expect(inset()).toBe("360px");
  });

  it("treats the chat beside a voice room the same way", async () => {
    chat(400, "voice-room-chat");
    await start(0);
    fire("keyboardWillShow", 300);
    expect(lifting()).toBe(true);
  });

  it("uses the animated layout outside the chat", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    await start(0);
    fire("keyboardWillShow", 300);

    expect(inset()).toBe("300px");
    expect(lifting()).toBe(false);
  });
});
