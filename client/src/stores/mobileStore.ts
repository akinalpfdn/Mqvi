/**
 * Mobile Store — Mobile UI state management.
 *
 * Only one drawer (left or right) can be open at a time.
 * Not used on desktop — components only subscribe when useIsMobile() is true.
 */

import { create } from "zustand";

type MobileState = {
  leftDrawerOpen: boolean;
  rightDrawerOpen: boolean;

  openLeftDrawer: () => void;
  closeLeftDrawer: () => void;
  openRightDrawer: () => void;
  closeRightDrawer: () => void;
  closeAllDrawers: () => void;
};

export const useMobileStore = create<MobileState>((set) => ({
  leftDrawerOpen: false,
  rightDrawerOpen: false,

  openLeftDrawer: () =>
    set({ leftDrawerOpen: true, rightDrawerOpen: false }),

  closeLeftDrawer: () =>
    set({ leftDrawerOpen: false }),

  openRightDrawer: () =>
    set({ rightDrawerOpen: true, leftDrawerOpen: false }),

  closeRightDrawer: () =>
    set({ rightDrawerOpen: false }),

  closeAllDrawers: () =>
    set({ leftDrawerOpen: false, rightDrawerOpen: false }),
}));
