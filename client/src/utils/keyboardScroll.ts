/**
 * Reveals a focused field that the Android soft keyboard would otherwise cover.
 *
 * The activity is windowSoftInputMode=adjustNothing, so the WebView is never told the
 * viewport shrank and cannot scroll the field into view on its own. This does only that
 * one job: no element is repositioned, nothing is resized. The field's own scroll
 * container moves by exactly the hidden amount, and only when it is genuinely hidden —
 * a field the WebView already revealed measures as visible and is left alone.
 *
 * iOS resizes the WebView natively (Keyboard `resize: "native"`), so this is Android-only.
 */

import { Keyboard } from "@capacitor/keyboard";

/** Breathing room between the field and the top of the keyboard. */
const CLEARANCE = 12;

let keyboardHeight = 0;

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

function revealFocusedField(): void {
  if (keyboardHeight === 0) return;

  const element = document.activeElement;
  if (!isTextEntry(element)) return;

  const visibleBottom = window.innerHeight - keyboardHeight;
  const hidden = element.getBoundingClientRect().bottom + CLEARANCE - visibleBottom;
  if (hidden <= 0) return;

  findScroller(element)?.scrollBy({ top: hidden, behavior: "smooth" });
}

export async function initKeyboardScroll(): Promise<void> {
  await Keyboard.addListener("keyboardDidShow", (info) => {
    keyboardHeight = info.keyboardHeight;
    revealFocusedField();
  });

  await Keyboard.addListener("keyboardDidHide", () => {
    keyboardHeight = 0;
  });

  // Moving between fields while the keyboard is already up fires no keyboard event.
  document.addEventListener("focusin", () => {
    requestAnimationFrame(revealFocusedField);
  });
}
