/**
 * EmojiPicker — lazy boundary around the real picker.
 *
 * `@emoji-mart/data` is the single largest thing in the bundle and every user paid for it on first
 * load, whether or not they ever opened a picker. It is loaded now on first open instead.
 *
 * The boundary lives in this module rather than at the call sites deliberately: there are nine of
 * them (composer, reactions, hover actions, channel tree, three settings panels, channel create,
 * soundboard) and one of them forgetting to wrap would quietly put the whole payload back into the
 * initial chunk. Callers import this exactly as before.
 */

import { lazy, Suspense } from "react";
import type { EmojiPickerProps } from "./EmojiPickerPanel";

const EmojiPickerPanel = lazy(() => import("./EmojiPickerPanel"));

function EmojiPicker(props: EmojiPickerProps) {
  // No spinner: every caller renders this behind its own open/closed flag, so the fallback would
  // be a flash of chrome between the click and the panel. An empty placeholder keeps the layout
  // still while the chunk arrives.
  return (
    <Suspense fallback={null}>
      <EmojiPickerPanel {...props} />
    </Suspense>
  );
}

export default EmojiPicker;
