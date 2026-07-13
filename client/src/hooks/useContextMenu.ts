/**
 * useContextMenu — Right-click context menu state hook.
 *
 * Each component manages its own menu state via this hook.
 * The shared ContextMenu component only handles rendering.
 */

import { useState, useCallback } from "react";

export type ContextMenuItem = {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Show separator line before this item */
  separator?: boolean;
};

export type ContextMenuState = {
  isOpen: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  /**
   * Dropped from a button rather than summoned at the pointer, so x/y is the button's
   * bottom-right corner and the menu stays a dropdown on mobile — where a right-click menu
   * turns into a bottom sheet instead.
   */
  anchored?: boolean;
};

const CLOSED_STATE: ContextMenuState = {
  isOpen: false,
  x: 0,
  y: 0,
  items: [],
};

export function useContextMenu() {
  const [menuState, setMenuState] = useState<ContextMenuState>(CLOSED_STATE);

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

  /** Drops a menu under a toolbar button, right-aligned to it. */
  const openMenuAt = useCallback(
    (e: React.MouseEvent<HTMLElement>, items: ContextMenuItem[]) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      setMenuState({
        isOpen: true,
        x: rect.right,
        y: rect.bottom + 4,
        items,
        anchored: true,
      });
    },
    []
  );

  const closeMenu = useCallback(() => {
    setMenuState(CLOSED_STATE);
  }, []);

  return { menuState, openMenu, openMenuAt, closeMenu };
}
