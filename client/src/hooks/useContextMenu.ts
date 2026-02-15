/**
 * useContextMenu — Sağ tık context menu state yönetimi hook'u.
 *
 * Bu hook, herhangi bir component'te sağ tık menüsü eklemek için
 * kullanılır. Menü pozisyonu (x, y), visibility ve item'lar bu
 * hook tarafından yönetilir.
 *
 * Kullanım:
 * ```tsx
 * const { menuState, openMenu, closeMenu } = useContextMenu();
 *
 * <div onContextMenu={(e) => openMenu(e, items)}>
 *   ...
 * </div>
 *
 * <ContextMenu state={menuState} onClose={closeMenu} />
 * ```
 *
 * Neden ayrı hook?
 * Context menu state'i component-local'dir (her component kendi menüsünü
 * yönetir). Shared ContextMenu component'i sadece render'dan sorumludur —
 * state yönetimi hook'ta kalır (Single Responsibility).
 */

import { useState, useCallback } from "react";

export type ContextMenuItem = {
  /** Menü öğesinin label'ı */
  label: string;
  /** Tıklanınca çalışacak fonksiyon */
  onClick: () => void;
  /** Danger stili (kırmızı renk — silme, ban gibi) */
  danger?: boolean;
  /** Devre dışı bırakma */
  disabled?: boolean;
  /** Ayırıcı çizgi (separator) — bu item'dan önce çizgi göster */
  separator?: boolean;
};

export type ContextMenuState = {
  /** Menü açık mı? */
  isOpen: boolean;
  /** Menü pozisyonu (piksel) */
  x: number;
  y: number;
  /** Menü öğeleri */
  items: ContextMenuItem[];
};

const CLOSED_STATE: ContextMenuState = {
  isOpen: false,
  x: 0,
  y: 0,
  items: [],
};

export function useContextMenu() {
  const [menuState, setMenuState] = useState<ContextMenuState>(CLOSED_STATE);

  /**
   * openMenu — Sağ tık event'inde menüyü aç.
   *
   * preventDefault: Tarayıcının varsayılan sağ tık menüsünü engeller.
   * clientX/clientY: Mouse pozisyonu (viewport'a göre piksel).
   */
  const openMenu = useCallback(
    (e: React.MouseEvent, items: ContextMenuItem[]) => {
      e.preventDefault();
      e.stopPropagation();
      setMenuState({
        isOpen: true,
        x: e.clientX,
        y: e.clientY,
        items,
      });
    },
    []
  );

  const closeMenu = useCallback(() => {
    setMenuState(CLOSED_STATE);
  }, []);

  return { menuState, openMenu, closeMenu };
}
