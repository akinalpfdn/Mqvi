/**
 * Turning the phone sideways to watch a stream.
 *
 * The app is portrait-locked on a phone (OrientationPlugin.applyDefault): its layout is a single
 * column, and a landscape phone is wide enough to trip the desktop breakpoint, which then lays
 * three columns out on a 400px-tall screen. Someone's desktop stream is the one thing worth
 * turning the phone for, so it is the one thing that turns it.
 *
 * Native does the real rotation. The browser can only do it from inside fullscreen — and it
 * refuses outright on desktop — so on the web this degrades to "fullscreen, still portrait",
 * which is still better than the postage stamp.
 */

import { registerPlugin } from "@capacitor/core";
import { isCapacitor } from "./constants";

type OrientationPlugin = {
  lockLandscape(): Promise<void>;
  restoreDefault(): Promise<void>;
};

const Orientation = registerPlugin<OrientationPlugin>("Orientation");

// lib.dom does not carry lock/unlock — they are the Screen Orientation API, which TypeScript
// still treats as optional. Optional here too: a desktop browser refuses the lock outright.
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape") => Promise<void>;
  unlock?: () => void;
};

function orientationApi(): LockableOrientation | undefined {
  return screen.orientation as LockableOrientation | undefined;
}

/** Turn the screen sideways. `el` is only used on the web, where the lock needs fullscreen. */
export async function enterLandscape(el: HTMLElement | null): Promise<void> {
  if (isCapacitor()) {
    // The plugin is Android-only for now; on iOS the bridge rejects with "not implemented",
    // and callers fire this without awaiting. Swallowing it costs the rotation, not the view —
    // the overlay is already up.
    try {
      await Orientation.lockLandscape();
    } catch {
      /* no rotation on this platform */
    }
    return;
  }
  // The click that got us here is the user gesture requestFullscreen needs; the orientation
  // lock then needs the fullscreen. Either can be refused (desktop always refuses the lock) —
  // the caller's overlay stands on its own, so a refusal is not an error worth surfacing.
  try {
    if (el && !document.fullscreenElement) await el.requestFullscreen();
    await orientationApi()?.lock?.("landscape");
  } catch {
    /* portrait it is */
  }
}

/** Portrait on a phone, whatever it likes on a tablet. */
export async function restoreOrientation(): Promise<void> {
  if (isCapacitor()) {
    try {
      await Orientation.restoreDefault();
    } catch {
      /* never rotated in the first place */
    }
    return;
  }
  try {
    orientationApi()?.unlock?.();
    if (document.fullscreenElement) await document.exitFullscreen();
  } catch {
    /* nothing to undo */
  }
}
