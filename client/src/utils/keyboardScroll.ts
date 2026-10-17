/**
 * Reveals a focused field that the soft keyboard would otherwise hide.
 *
 * On both platforms the WebView keeps its size: the app shrinks above the keyboard through
 * `--keyboard-inset` (Android: native, per animation frame; iOS: iosKeyboardInset.ts, animated
 * on the keyboard's curve). The field's own scroll container moves by exactly the hidden
 * amount, and only when the field is genuinely hidden; a field above the keyboard is left alone.
 *
 * iOS starts at keyboardWillShow and scrolls on the keyboard's duration and curve, so the field
 * rises with the keyboard. The page gains its scroll room on that same curve as the inset
 * grows, so a field near the end of the page follows it up in one movement.
 */

import { Keyboard } from "@capacitor/keyboard";

/** Breathing room between the field and the top of the keyboard. */
const CLEARANCE = 12;
/** The iOS keyboard animation; globals.css `.keyboard-animated` uses the same values. */
const KEYBOARD_ANIMATION_MS = 250;
const KEYBOARD_CURVE = [0.38, 0.7, 0.125, 1] as const;

let keyboardHeight = 0;
let animation: { scroller: HTMLElement; top: number; frame: number } | null = null;

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

function cancelAnimation(): void {
  if (animation) cancelAnimationFrame(animation.frame);
  animation = null;
}

/** Scrolls on the keyboard's curve. The browser clamps each step to the room the page has then. */
function animateScroll(scroller: HTMLElement, top: number): void {
  cancelAnimation();
  const from = scroller.scrollTop;
  const started = performance.now();

  const step = (now: number) => {
    const t = Math.min(1, (now - started) / KEYBOARD_ANIMATION_MS);
    scroller.scrollTop = from + (top - from) * cubicBezier(KEYBOARD_CURVE, t);
    if (t < 1) {
      animation = { scroller, top, frame: requestAnimationFrame(step) };
    } else {
      animation = null;
    }
  };
  animation = { scroller, top, frame: requestAnimationFrame(step) };
}

function revealFocusedField(): void {
  if (keyboardHeight === 0) return;

  const element = document.activeElement;
  if (!isTextEntry(element)) return;
  const scroller = findScroller(element);
  if (!scroller) return;

  // The WebView never resizes for the keyboard, so its bottom edge minus the keyboard is the
  // visible bottom. Measured in the scroller's content, so the answer holds mid-animation.
  const visibleBottom = window.innerHeight - keyboardHeight;
  const scrollerTop = scroller.getBoundingClientRect().top;
  const fieldBottom = element.getBoundingClientRect().bottom - scrollerTop + scroller.scrollTop;
  const target = Math.ceil(fieldBottom + CLEARANCE - (visibleBottom - scrollerTop));

  if (animation?.scroller === scroller && animation.top === target) return;
  if (target <= scroller.scrollTop) return;

  animateScroll(scroller, target);
}

function clearHeight(): void {
  keyboardHeight = 0;
  cancelAnimation();
}

/** Starts revealing fields; the returned function removes every listener it added. */
export async function initKeyboardScroll(platform: "android" | "ios"): Promise<() => void> {
  const handles =
    platform === "ios"
      ? [
          // The height the WebView will lose (adjusted for iPad windows), as the keyboard starts.
          await Keyboard.addListener("keyboardWillShow", (info) => {
            keyboardHeight = info.keyboardHeight;
            requestAnimationFrame(revealFocusedField);
          }),
          // Whatever the page could not reach while its room was still growing.
          await Keyboard.addListener("keyboardDidShow", () => revealFocusedField()),
        ]
      : [
          await Keyboard.addListener("keyboardDidShow", (info) => {
            keyboardHeight = info.keyboardHeight;
            revealFocusedField();
          }),
        ];
  handles.push(
    await Keyboard.addListener("keyboardWillHide", clearHeight),
    await Keyboard.addListener("keyboardDidHide", clearHeight),
  );

  // A resize is a rotation; the keyboard reports its new height, the field may need moving.
  const onResize = () => revealFocusedField();
  // Moving between fields while the keyboard is already up fires no keyboard event.
  const onFocusIn = () => {
    requestAnimationFrame(revealFocusedField);
  };
  window.addEventListener("resize", onResize);
  document.addEventListener("focusin", onFocusIn);

  return () => {
    handles.forEach((handle) => void handle.remove());
    window.removeEventListener("resize", onResize);
    document.removeEventListener("focusin", onFocusIn);
    clearHeight();
  };
}
