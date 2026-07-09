/** Chat column layout: true when the message column is too tight for the wide layout.
 *  Measured from the real column width by MessageList, read by every picker in the chat
 *  column (reaction, edit, input emoji, input GIF) so they can switch to a bottom sheet.
 *  A store (not context) so MessageInput — a sibling of MessageList — can read it too. */

import { create } from "zustand";

type ChatLayoutState = {
  isNarrow: boolean;
  setIsNarrow: (v: boolean) => void;
};

const useChatLayoutStore = create<ChatLayoutState>((set) => ({
  isNarrow: false,
  setIsNarrow: (v) => set((s) => (s.isNarrow === v ? s : { isNarrow: v })),
}));

function useNarrowChat(): boolean {
  return useChatLayoutStore((s) => s.isNarrow);
}

export { useChatLayoutStore, useNarrowChat };
