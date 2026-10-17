/** Which fields the keyboard moves into view, and by how much, on each platform. */
import { describe, it, expect, beforeEach, vi } from "vitest";

const listeners = vi.hoisted(() => new Map<string, (info: { keyboardHeight: number }) => void>());

vi.mock("@capacitor/keyboard", () => ({
  Keyboard: {
    addListener: vi.fn(async (event: string, handler: (info: { keyboardHeight: number }) => void) => {
      listeners.set(event, handler);
      return { remove: vi.fn() };
    }),
  },
}));

const SCREEN = 800;
const KEYBOARD = 300;

/** A scrolling page holding one field whose bottom edge sits at `fieldBottom`. */
function page(fieldBottom: number) {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "scrollHeight", { value: 2000 });
  Object.defineProperty(scroller, "clientHeight", { value: 500 });
  scroller.scrollBy = vi.fn();

  const field = document.createElement("input");
  field.getBoundingClientRect = () => ({ bottom: fieldBottom }) as DOMRect;
  scroller.appendChild(field);
  document.body.appendChild(scroller);
  field.focus();
  return scroller.scrollBy as ReturnType<typeof vi.fn>;
}

async function start(platform: "android" | "ios", innerHeight: number) {
  vi.resetModules();
  listeners.clear();
  Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true });
  const { initKeyboardScroll } = await import("./keyboardScroll");
  await initKeyboardScroll(platform);
  listeners.get("keyboardDidShow")?.({ keyboardHeight: KEYBOARD });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("iOS, where the web view shrinks above the keyboard", () => {
  it("leaves a field near the top where it is", async () => {
    const scrollBy = page(120);
    await start("ios", SCREEN - KEYBOARD);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("scrolls a field below the new bottom edge just into view", async () => {
    const scrollBy = page(650);
    await start("ios", SCREEN - KEYBOARD);
    expect(scrollBy).toHaveBeenCalledWith({ top: 650 + 12 - (SCREEN - KEYBOARD), behavior: "smooth" });
  });
});

describe("Android, where the keyboard covers the web view", () => {
  it("leaves a field above the keyboard where it is", async () => {
    const scrollBy = page(120);
    await start("android", SCREEN);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it("scrolls a field under the keyboard just into view", async () => {
    const scrollBy = page(650);
    await start("android", SCREEN);
    expect(scrollBy).toHaveBeenCalledWith({ top: 650 + 12 - (SCREEN - KEYBOARD), behavior: "smooth" });
  });
});
