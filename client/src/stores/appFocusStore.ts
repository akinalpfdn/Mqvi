import { create } from "zustand";

/**
 * Is the user actually in front of the app?
 *
 * The DM read loop hangs off this: a conversation on screen is marked read, its badge clears on
 * every device, and the server suppresses the phone push. So a wrong answer here is expensive in
 * both directions — a false negative means the phone buzzes for the chat the user is reading, and
 * a false positive means a notification is retracted for a message they never saw.
 *
 * On native this is deliberately NOT document.hasFocus(). An Android WebView can report
 * hasFocus() === false while the app is in the foreground (focus sitting on a native view, or no
 * focused element after a resume), which would silently reproduce the exact bug this whole branch
 * exists to fix. Native uses the Capacitor app state instead — see utils/appFocus.ts.
 *
 * null means "not known yet": the native app state has not answered. Claim nothing until it does.
 */
type AppFocusStore = {
  isForeground: boolean | null;
  setForeground: (value: boolean | null) => void;
};

export const useAppFocusStore = create<AppFocusStore>((set) => ({
  isForeground: null,
  setForeground: (value) => set({ isForeground: value }),
}));

/** Non-reactive read, for event handlers outside React. Unknown counts as "not looking". */
export function isAppInForeground(): boolean {
  return useAppFocusStore.getState().isForeground === true;
}
