/**
 * LIFO registry of "close the top-most UI layer" handlers.
 *
 * The Android hardware back button consults this before navigating or minimizing, so a
 * full-screen panel can never trap the user. Layers register while they are mounted.
 */

type BackHandler = () => void;

/** Back reaches a higher priority first, then the most recent layer within a priority. */
export const BackPriority = {
  /** Panels, sheets, dialogs. */
  Layer: 0,
  /** Something drawn above every layer (the guide spotlight), even ones opened after it. */
  Overlay: 1,
} as const;

type Entry = { handler: BackHandler; priority: number };

const entries: Entry[] = [];

/** Registers a handler for as long as the layer is open. Returns the unregister function. */
export function pushBackHandler(handler: BackHandler, priority: number = BackPriority.Layer): () => void {
  const entry: Entry = { handler, priority };
  entries.push(entry);

  return () => {
    const index = entries.lastIndexOf(entry);
    if (index !== -1) entries.splice(index, 1);
  };
}

/** Closes the top-most layer. Returns false when nothing was open. */
export function handleBack(): boolean {
  let top = -1;
  for (let i = 0; i < entries.length; i++) {
    if (top === -1 || entries[i].priority >= entries[top].priority) top = i;
  }
  if (top === -1) return false;

  const [entry] = entries.splice(top, 1);
  entry.handler();
  return true;
}
