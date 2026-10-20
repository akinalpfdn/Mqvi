/**
 * Reveals a focused field that the soft keyboard would otherwise hide.
 *
 * On both platforms the WebView keeps its size: the app shrinks above the keyboard through
 * `--keyboard-inset` (Android: native, per animation frame; iOS: iosKeyboardInset.ts, animated
 * on the keyboard's curve). The field's own scroll container moves by exactly the hidden
 * amount, and only when the field is genuinely hidden; a field above the keyboard is left alone.
 *
 * Both platforms start as the keyboard starts (iOS: the Keyboard plugin's keyboardWillShow;
 * Android: MainActivity's `mqvikeyboard` events, since its keyboard animation callback replaces
 * the plugin's) and scroll over the keyboard's duration, so the field
 * rises with the keyboard. The page gains its scroll room on that same curve as the inset
 * grows, so a field near the end of the page follows it up in one movement. A page that cannot
 * scroll yet (a short form) is looked at again every frame of the rise, and its scroll joins the
 * keyboard's curve where the keyboard is by then.
 */

import { Keyboard } from "@capacitor/keyboard";

/** Breathing room between the field and the top of the keyboard. */
const CLEARANCE = 12;
/** The iOS keyboard animation; globals.css `.keyboard-animated` uses the same values. */
const KEYBOARD_ANIMATION_MS = 250;

/** Sent by MainActivity (Android) as the keyboard animation starts and ends. */
type NativeKeyboardEvent = CustomEvent<{
  phase: "willShow" | "didShow" | "willHide" | "didHide";
  /** The whole keyboard from the screen's bottom edge, in CSS px; 0 while hidden. */
  height: number;
  /** The animation's length (willShow / willHide); 0 when it has ended. */
  duration: number;
}>;
const KEYBOARD_CURVE = [0.38, 0.7, 0.125, 1] as const;

/** One `initKeyboardScroll` call's state. */
type Revealer = {
  keyboardHeight: number;
  animation: { scroller: HTMLElement; top: number; frame: number } | null;
  /** The frame that looks again for a scrollable page while the iOS keyboard rises. */
  riseFrame: number | null;
};

function isTextEntry(element: Element | null): element is HTMLElement {
  if (!element) return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    (element as HTMLElement).isContentEditable
  );
}

/** Nearest ancestor that can actually scroll, or null when the field sits in a fixed box. */
function findScroller(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement;

  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }

  return null;
}

/** CSS cubic-bezier easing: progress at time fraction `t`. */
export function cubicBezier([x1, y1, x2, y2]: readonly [number, number, number, number], t: number): number {
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s ** 2 * (1 - s) + s ** 3;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    if (at(x1, x2, mid) < t) low = mid;
    else high = mid;
  }
  return at(y1, y2, (low + high) / 2);
}

function cancelAnimation(r: Revealer): void {
  if (r.animation) cancelAnimationFrame(r.animation.frame);
  r.animation = null;
  if (r.riseFrame !== null) cancelAnimationFrame(r.riseFrame);
  r.riseFrame = null;
}

/**
 * Scrolls on the keyboard's curve, ending when a keyboard that started moving at `startedAt`
 * stops; joining late, it covers the rest of the curve. The browser clamps each step to the
 * room the page has then.
 */
function animateScroll(
  r: Revealer,
  scroller: HTMLElement,
  top: number,
  startedAt = performance.now(),
  durationMs = KEYBOARD_ANIMATION_MS,
): void {
  if (r.animation) cancelAnimationFrame(r.animation.frame);
  const from = scroller.scrollTop;
  const progress = (now: number) => cubicBezier(KEYBOARD_CURVE, Math.min(1, Math.max(0, (now - startedAt) / durationMs)));
  const joined = progress(performance.now());

  const step = (now: number) => {
    const t = Math.min(1, (now - startedAt) / durationMs);
    scroller.scrollTop = from + (top - from) * (joined >= 1 ? 1 : (progress(now) - joined) / (1 - joined));
    if (t < 1) {
      r.animation = { scroller, top, frame: requestAnimationFrame(step) };
    } else {
      r.animation = null;
    }
  };
  r.animation = { scroller, top, frame: requestAnimationFrame(step) };
}

function revealFocusedField(r: Revealer, startedAt?: number, durationMs?: number): void {
  if (r.keyboardHeight === 0) return;

  const element = document.activeElement;
  if (!isTextEntry(element)) return;
  const scroller = findScroller(element);
  if (!scroller) return;

  // The WebView never resizes for the keyboard, so its bottom edge minus the keyboard is the
  // visible bottom. Measured in the scroller's content, so the answer holds mid-animation.
  const visibleBottom = window.innerHeight - r.keyboardHeight;
  const scrollerTop = scroller.getBoundingClientRect().top;
  const fieldBottom = element.getBoundingClientRect().bottom - scrollerTop + scroller.scrollTop;
  const target = Math.ceil(fieldBottom + CLEARANCE - (visibleBottom - scrollerTop));

  if (r.animation?.scroller === scroller && r.animation.top === target) return;
  if (target <= scroller.scrollTop) return;

  animateScroll(r, scroller, target, startedAt, durationMs);
}

/** Looks for the field's scroller every frame of the keyboard's rise until it can scroll. */
function revealWhileRising(r: Revealer, durationMs = KEYBOARD_ANIMATION_MS): void {
  const startedAt = performance.now();
  const tick = () => {
    r.riseFrame = null;
    revealFocusedField(r, startedAt, durationMs);
    if (!r.animation && performance.now() - startedAt < durationMs) r.riseFrame = requestAnimationFrame(tick);
  };
  if (r.riseFrame !== null) cancelAnimationFrame(r.riseFrame);
  r.riseFrame = requestAnimationFrame(tick);
}

function clearHeight(r: Revealer): void {
  r.keyboardHeight = 0;
  cancelAnimation(r);
}

/** Starts revealing fields; the returned function removes every listener it added. */
export async function initKeyboardScroll(platform: "android" | "ios"): Promise<() => void> {
  const r: Revealer = { keyboardHeight: 0, animation: null, riseFrame: null };
  const clear = () => clearHeight(r);
  const handles: { remove: () => Promise<void> }[] = [];
  if (platform === "ios") {
    handles.push(
      // The height the WebView will lose (adjusted for iPad windows), as the keyboard starts.
      await Keyboard.addListener("keyboardWillShow", (info) => {
        r.keyboardHeight = info.keyboardHeight;
        revealWhileRising(r);
      }),
      // Whatever the page could not reach while its room was still growing.
      await Keyboard.addListener("keyboardDidShow", () => revealFocusedField(r)),
      await Keyboard.addListener("keyboardWillHide", clear),
      await Keyboard.addListener("keyboardDidHide", clear),
    );
  }

  const onNativeKeyboard = (event: Event) => {
    // Dispatched by native code; the window event map has no entry for it.
    const { phase, height, duration } = (event as NativeKeyboardEvent).detail;
    if (phase === "willShow") {
      r.keyboardHeight = height;
      revealWhileRising(r, duration > 0 ? duration : KEYBOARD_ANIMATION_MS);
    } else if (phase === "didShow") {
      r.keyboardHeight = height;
      revealFocusedField(r);
    } else {
      clear();
    }
  };
  if (platform === "android") window.addEventListener("mqvikeyboard", onNativeKeyboard);

  // A resize is a rotation; the keyboard reports its new height, the field may need moving.
  const onResize = () => revealFocusedField(r);
  // Moving between fields while the keyboard is already up fires no keyboard event.
  const onFocusIn = () => {
    requestAnimationFrame(() => revealFocusedField(r));
  };
  window.addEventListener("resize", onResize);
  document.addEventListener("focusin", onFocusIn);

  return () => {
    handles.forEach((handle) => void handle.remove());
    window.removeEventListener("mqvikeyboard", onNativeKeyboard);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("focusin", onFocusIn);
    clear();
  };
}
