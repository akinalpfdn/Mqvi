/**
 * Right-click menus by long press on iOS. WebKit there never turns a long press into a contextmenu
 * event (desktop has the right click, Android makes one itself), so the menus were unreachable.
 * A long press dispatches a real contextmenu event at the finger, and the element's own
 * onContextMenu opens its menu exactly as for a right click. Spread the handlers onto that element.
 */

import { useCallback } from "react";

import { isIOSWebKit } from "../utils/constants";
import { useLongPress, type LongPressCallback } from "./useLongPress";

type TouchHandlers = {
  onTouchStart?: (e: React.TouchEvent) => void;
  onTouchMove?: (e: React.TouchEvent) => void;
  onTouchEnd?: (e: React.TouchEvent) => void;
  onTouchCancel?: () => void;
};

const EDITABLE = "input, textarea, [contenteditable]";
const RELEASE_MOUSE_EVENTS = ["mousedown", "mouseup", "click"] as const;
/** Bounds the swallowing when the release brings no mouse events at all (the press was cancelled). */
const RELEASE_WINDOW_MS = 5_000;

/**
 * The finger lifting from the press that opened a menu must not close it: iOS turns the release into
 * mousedown, mouseup and click, and menus close on a mousedown outside them. Cancelling touchend
 * stops that only when a touchend comes; when the system takes the touch over (an image lifted for
 * dragging on iPad) none does. So the release's mouse events are swallowed before anything sees
 * them, until they have passed, a new touch begins, or the window runs out.
 */
function swallowReleaseMouseEvents(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => {
    clearTimeout(timer);
    for (const type of RELEASE_MOUSE_EVENTS) document.removeEventListener(type, swallow, true);
    document.removeEventListener("touchstart", disarm, true);
  };
  const swallow = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.type === "click") disarm(); // the release's sequence is over
  };
  for (const type of RELEASE_MOUSE_EVENTS) document.addEventListener(type, swallow, true);
  // A new touch is a new gesture: tapping an item of the menu just opened must reach it.
  document.addEventListener("touchstart", disarm, true);
  timer = setTimeout(disarm, RELEASE_WINDOW_MS);
}

export function useLongPressContextMenu(): TouchHandlers {
  const openMenu = useCallback<LongPressCallback>(({ clientX, clientY, target }) => {
    swallowReleaseMouseEvents();
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY }));
  }, []);
  const { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } = useLongPress(openMenu);

  // Holding inside an inline rename field places the caret; it is not a request for the menu.
  const start = useCallback(
    (e: React.TouchEvent) => {
      if (e.target instanceof Element && e.target.closest(EDITABLE)) return;
      onTouchStart(e);
    },
    [onTouchStart],
  );

  if (!isIOSWebKit()) return {};
  return { onTouchStart: start, onTouchMove, onTouchEnd, onTouchCancel };
}
