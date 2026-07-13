/**
 * ContextMenu — Portal-rendered right-click menu.
 * Auto-adjusts position to stay within viewport.
 * Closes on outside click or Escape.
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ContextMenuState } from "../../hooks/useContextMenu";

type ContextMenuProps = {
  state: ContextMenuState;
  onClose: () => void;
};

function ContextMenu({ state, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!state.isOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    // Wait one frame so the right-click event itself isn't caught as "click outside"
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    });

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [state.isOpen, onClose]);

  // Clamp position to viewport
  useEffect(() => {
    if (!state.isOpen || !menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    // Anchored: x/y is the button's bottom-right, so hang the menu leftwards from it.
    let adjustedX = state.anchored ? state.x - rect.width : state.x;
    let adjustedY = state.y;

    if (adjustedX + rect.width > viewportW - 8) {
      adjustedX = viewportW - rect.width - 8;
    }
    if (adjustedX < 8) adjustedX = 8;

    // Shift up if overflowing bottom
    if (adjustedY + rect.height > viewportH - 8) {
      adjustedY = viewportH - rect.height - 8;
    }

    if (state.anchored) {
      // The mobile stylesheet pins .ctx-menu to the bottom of the screen with !important —
      // right for a long-press menu, wrong for a dropdown. Only an inline !important outranks it.
      menu.style.setProperty("left", `${adjustedX}px`, "important");
      menu.style.setProperty("top", `${adjustedY}px`, "important");
      menu.style.setProperty("right", "auto", "important");
      menu.style.setProperty("bottom", "auto", "important");
    } else {
      menu.style.left = `${adjustedX}px`;
      menu.style.top = `${adjustedY}px`;
    }
  }, [state.isOpen, state.x, state.y, state.anchored]);

  if (!state.isOpen) return null;

  return createPortal(
    <div
      ref={menuRef}
      className={`ctx-menu${state.anchored ? " ctx-menu-anchored" : ""}`}
      style={{ left: state.x, top: state.y }}
    >
      {state.items.map((item, i) => (
        <div key={i}>
          {item.separator && <div className="ctx-separator" />}
          <button
            className={`ctx-item${item.danger ? " ctx-danger" : ""}${item.disabled ? " ctx-disabled" : ""}`}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
            disabled={item.disabled}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>,
    document.body
  );
}

export default ContextMenu;
