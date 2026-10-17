/**
 * Reveals a focused field that the soft keyboard would otherwise hide.
 *
 * Android is windowSoftInputMode=adjustNothing: the WebView keeps its size and the keyboard
 * covers its bottom. iOS shrinks the WebView (Keyboard `resize: "native"`), and the plugin
 * detaches the WebView's own keyboard scrolling, so a field below the new bottom edge stays
 * out of sight. Either way this does one job: the field's own scroll container moves by
 * exactly the hidden amount, and only when the field is genuinely hidden.
 */

import { Keyboard } from "@capacitor/keyboard";

/** Breathing room between the field and the top of the keyboard. */
const CLEARANCE = 12;

let keyboardHeight = 0;
/** Android: the keyboard overlays the WebView. iOS: the WebView already shrank above it. */
let keyboardOverlaysView = false;

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

  const visibleBottom = window.innerHeight - (keyboardOverlaysView ? keyboardHeight : 0);
  const hidden = element.getBoundingClientRect().bottom + CLEARANCE - visibleBottom;
  if (hidden <= 0) return;

  findScroller(element)?.scrollBy({ top: hidden, behavior: "smooth" });
}

export async function initKeyboardScroll(platform: "android" | "ios"): Promise<void> {
  keyboardOverlaysView = platform === "android";

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
