/**
 * Reveals a focused field that the soft keyboard would otherwise hide.
 *
 * Android is windowSoftInputMode=adjustNothing: the WebView keeps its size and the keyboard
 * covers its bottom. iOS shrinks the WebView (Keyboard `resize: "native"`), but only 0.2 s
 * after the keyboard has finished animating in, and the plugin detaches the WebView's own
 * keyboard scrolling. So the visible bottom is taken from the keyboard height, never from
 * the WebView's current size alone, and the check runs again once the WebView has shrunk.
 *
 * One job: the field's own scroll container moves by exactly the hidden amount, and only
 * when the field is genuinely hidden. A field above the keyboard is left alone.
 */

import { Keyboard } from "@capacitor/keyboard";

/** Breathing room between the field and the top of the keyboard. */
const CLEARANCE = 12;

let keyboardHeight = 0;
/** WebView height with no keyboard up; on iOS it shrinks while the keyboard shows. */
let fullHeight = 0;

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

/** iOS only: the WebView has not shrunk yet, so the page cannot scroll as far as it will. */
let awaitingShrink = false;
let shrinkFallback: ReturnType<typeof setTimeout> | undefined;
/** The scroll position last asked for; a smooth scroll still running must not be asked again. */
let requested: { scroller: HTMLElement; top: number } | null = null;

/** iOS shrinks the WebView 0.2 s after keyboardDidShow; past this, stop waiting for it. */
const SHRINK_WAIT_MS = 500;

function revealFocusedField(): void {
  if (keyboardHeight === 0) return;

  const element = document.activeElement;
  if (!isTextEntry(element)) return;
  const scroller = findScroller(element);
  if (!scroller) return;

  // Measured in the scroller's content, so the answer is the same mid-animation.
  const visibleBottom = Math.min(window.innerHeight, fullHeight - keyboardHeight);
  const scrollerTop = scroller.getBoundingClientRect().top;
  const fieldBottom = element.getBoundingClientRect().bottom - scrollerTop + scroller.scrollTop;
  const target = Math.ceil(fieldBottom + CLEARANCE - (visibleBottom - scrollerTop));

  if (target <= scroller.scrollTop) return;
  if (requested?.scroller === scroller && requested.top === target) return;
  // One movement, not two: a field near the end of the page waits until the WebView has
  // shrunk and the page can scroll the whole way.
  if (awaitingShrink && target > scroller.scrollHeight - scroller.clientHeight) return;

  requested = { scroller, top: target };
  scroller.scrollTo({ top: target, behavior: "smooth" });
}

function stopAwaitingShrink(): void {
  awaitingShrink = false;
  clearTimeout(shrinkFallback);
}

function clearHeight(): void {
  keyboardHeight = 0;
  requested = null;
  stopAwaitingShrink();
}

/** Starts revealing fields; the returned function removes every listener it added. */
export async function initKeyboardScroll(platform: "android" | "ios"): Promise<() => void> {
  fullHeight = window.innerHeight;

  // iOS reports the height the WebView will lose in keyboardWillShow (adjusted for iPad
  // windows); keyboardDidShow carries the raw keyboard frame. Android reports it on show.
  const handles = [
    platform === "ios"
      ? await Keyboard.addListener("keyboardWillShow", (info) => {
          keyboardHeight = info.keyboardHeight;
          if (window.innerHeight >= fullHeight) awaitingShrink = true;
        })
      : await Keyboard.addListener("keyboardDidShow", (info) => {
          keyboardHeight = info.keyboardHeight;
        }),
    await Keyboard.addListener("keyboardDidShow", () => {
      revealFocusedField();
      if (awaitingShrink) {
        clearTimeout(shrinkFallback);
        shrinkFallback = setTimeout(() => {
          stopAwaitingShrink();
          revealFocusedField();
        }, SHRINK_WAIT_MS);
      }
    }),
    await Keyboard.addListener("keyboardWillHide", clearHeight),
    await Keyboard.addListener("keyboardDidHide", clearHeight),
  ];

  // iOS: the WebView shrinks after the keyboard is up, which first makes room to scroll
  // a field near the end of the page. With no keyboard, a resize is a rotation.
  const onResize = () => {
    if (keyboardHeight === 0) {
      fullHeight = window.innerHeight;
    } else {
      stopAwaitingShrink();
      revealFocusedField();
    }
  };
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
