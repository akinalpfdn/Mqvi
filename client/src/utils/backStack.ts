/**
 * LIFO registry of "close the top-most UI layer" handlers.
 *
 * The Android hardware back button consults this before navigating or minimizing, so a
 * full-screen panel can never trap the user. Layers register while they are mounted.
 */

type BackHandler = () => void;

const handlers: BackHandler[] = [];

/** Registers a handler for as long as the layer is open. Returns the unregister function. */
export function pushBackHandler(handler: BackHandler): () => void {
  handlers.push(handler);

  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index !== -1) handlers.splice(index, 1);
  };
}

/** Closes the top-most layer. Returns false when nothing was open. */
export function handleBack(): boolean {
  const handler = handlers.pop();
  if (!handler) return false;

  handler();
  return true;
}
