/** Narrow-column context: true when the message column is too tight for the wide layout.
 *  Measured from the actual column width (not the window), so split-view with both sidebars
 *  open reflows just like mobile. Provided by MessageList, consumed by reaction pickers. */

import { createContext, useContext } from "react";

const NarrowChatContext = createContext(false);

function useNarrowChat(): boolean {
  return useContext(NarrowChatContext);
}

export { NarrowChatContext, useNarrowChat };
