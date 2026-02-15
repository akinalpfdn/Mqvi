/**
 * ContextMenu — Paylaşılan sağ tık menü component'i.
 *
 * Portal ile document.body'ye render edilir — böylece
 * overflow:hidden olan parent container'ların dışına çıkabilir.
 *
 * Pozisyon: Mouse tıklama noktasına göre. Eğer menü ekranın
 * sağına veya altına taşarsa otomatik olarak sola/yukarıya kaydırılır.
 *
 * Kapatma: Menü dışına tıklama veya Escape tuşu.
 *
 * CSS: .ctx-menu, .ctx-item, .ctx-separator class'ları
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

  // Menü dışına tıklama ve Escape ile kapatma
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

    // requestAnimationFrame ile bir frame bekle — aksi takdirde
    // sağ tık event'i kendisi de "click outside" olarak algılanır.
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    });

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [state.isOpen, onClose]);

  // Pozisyon düzeltme — ekranın dışına taşmayı önle
  useEffect(() => {
    if (!state.isOpen || !menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let adjustedX = state.x;
    let adjustedY = state.y;

    // Sağa taşıyorsa sola kaydır
    if (adjustedX + rect.width > viewportW - 8) {
      adjustedX = viewportW - rect.width - 8;
    }

    // Alta taşıyorsa yukarı kaydır
    if (adjustedY + rect.height > viewportH - 8) {
      adjustedY = viewportH - rect.height - 8;
    }

    menu.style.left = `${adjustedX}px`;
    menu.style.top = `${adjustedY}px`;
  }, [state.isOpen, state.x, state.y]);

  if (!state.isOpen) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="ctx-menu"
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
