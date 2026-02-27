/**
 * mobileStore — Mobil UI state yönetimi.
 *
 * Drawer'lar (sidebar/members) ve mobil-specific state burada tutulur.
 * Desktop modda bu store kullanılmaz — sadece `useIsMobile()` true
 * olduğunda component'ler bu store'a subscribe olur.
 *
 * Drawer mantığı:
 * - Aynı anda sadece bir drawer açık olabilir (sol veya sağ)
 * - Kanal seçildiğinde sol drawer otomatik kapanır
 * - Backdrop tıklandığında veya swipe ile kapatılır
 */

import { create } from "zustand";

type MobileState = {
  /** Sol drawer (sidebar) açık mı? */
  leftDrawerOpen: boolean;
  /** Sağ drawer (member list) açık mı? */
  rightDrawerOpen: boolean;

  // ─── Actions ───

  /** Sol drawer'ı aç (sağ drawer açıksa kapat) */
  openLeftDrawer: () => void;
  /** Sol drawer'ı kapat */
  closeLeftDrawer: () => void;
  /** Sağ drawer'ı aç (sol drawer açıksa kapat) */
  openRightDrawer: () => void;
  /** Sağ drawer'ı kapat */
  closeRightDrawer: () => void;
  /** Tüm drawer'ları kapat */
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
