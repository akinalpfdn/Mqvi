/**
 * iOS keyboard → `--keyboard-inset`, the variable Android's native code already drives.
 *
 * The Keyboard plugin runs with `resize: "none"`: its native resize waited for the keyboard
 * animation plus 0.2 s and then snapped the WebView, so content sat under the keyboard and
 * jumped. Here the app follows the keyboard from the moment it starts to move, on its curve.
 *
 * Two ways, chosen by where the focus is:
 * - Layout (default): the inset itself animates, so the layout shrinks frame by frame. Smooth
 *   on light screens, and it gives a scrolling form room to bring a low field up as it goes.
 * - Lift (chat): re-laying out a long message list every frame drops frames, so the chat moves
 *   by translation alone (`--keyboard-lift`, globals.css `.keyboard-lifting`) and the layout
 *   catches up in a single step where the two look identical: after a rise, before a fall.
 */

import { Keyboard } from "@capacitor/keyboard";

/** globals.css `.keyboard-animated` runs the same duration. */
const KEYBOARD_ANIMATION_MS = 250;
// Text channels and DMs, and the chat beside a voice room.
const LIFT_SCOPE = ".chat-area, .voice-room-chat";

const root = () => document.documentElement;

/** The inset the layout currently uses. */
let applied = 0;
let liftMode = false;
let commitTimer: ReturnType<typeof setTimeout> | undefined;
let commit: (() => void) | null = null;

/** The bottom safe area in px (home indicator); the keyboard height already covers it. */
function safeAreaBottom(): number {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom,0px)";
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
  return px;
}

function setVar(name: "--keyboard-inset" | "--keyboard-lift", px: number): void {
  root().style.setProperty(name, `${px}px`);
}

/** Applies changes with no transition, as one style update. */
function instantly(change: () => void): void {
  root().classList.add("keyboard-instant");
  change();
  void getComputedStyle(root()).getPropertyValue("--keyboard-inset"); // flush before re-enabling
  root().classList.remove("keyboard-instant");
}

/**
 * Keeps each message list's content where it is on screen while the layout swaps in for the
 * translation: the list's height changes by `delta`, so its scroll position moves with it.
 */
function holdChatScroll(delta: number, change: () => void): void {
  const lists = Array.from(document.querySelectorAll<HTMLElement>(".messages-scroll"), (el) => [el, el.scrollTop] as const);
  change();
  for (const [el, top] of lists) el.scrollTop = top + delta;
}

/** Finishes a rise still in flight, so the next change starts from a settled layout. */
function settle(): void {
  clearTimeout(commitTimer);
  const pending = commit;
  commit = null;
  pending?.();
}

function moveTo(target: number): void {
  settle();

  if (!liftMode) {
    root().classList.remove("keyboard-lifting");
    setVar("--keyboard-inset", target);
    applied = target;
    return;
  }

  root().classList.add("keyboard-lifting");
  if (target > applied) {
    // Rise: the old layout stays while the chat translates up; then the layout takes over.
    const rise = target - applied;
    setVar("--keyboard-lift", rise);
    commit = () => {
      instantly(() =>
        holdChatScroll(rise, () => {
          setVar("--keyboard-inset", target);
          setVar("--keyboard-lift", 0);
          root().classList.remove("keyboard-lifting");
        }),
      );
      applied = target;
    };
    commitTimer = setTimeout(settle, KEYBOARD_ANIMATION_MS);
  } else {
    // Fall: the layout grows at once, the chat held where it was, then translates down.
    const from = applied - target;
    instantly(() =>
      holdChatScroll(-from, () => {
        setVar("--keyboard-inset", target);
        setVar("--keyboard-lift", from);
      }),
    );
    applied = target;
    setVar("--keyboard-lift", 0);
    commit = () => root().classList.remove("keyboard-lifting");
    commitTimer = setTimeout(settle, KEYBOARD_ANIMATION_MS);
  }
}

/** Starts driving the inset; the returned function stops it and clears the inset. */
export async function initIosKeyboardInset(): Promise<() => void> {
  root().classList.add("keyboard-animated");

  const handles = [
    await Keyboard.addListener("keyboardWillShow", (info) => {
      // Decided as the keyboard opens; a height change while open keeps the same way.
      if (applied === 0 && !commit) liftMode = !!document.activeElement?.closest(LIFT_SCOPE);
      moveTo(Math.max(0, info.keyboardHeight - safeAreaBottom()));
    }),
    await Keyboard.addListener("keyboardWillHide", () => {
      moveTo(0);
    }),
  ];

  return () => {
    handles.forEach((handle) => void handle.remove());
    clearTimeout(commitTimer);
    commit = null;
    instantly(() => {
      setVar("--keyboard-inset", 0);
      setVar("--keyboard-lift", 0);
    });
    root().classList.remove("keyboard-animated", "keyboard-lifting");
    applied = 0;
    liftMode = false;
  };
}
