/**
 * FilterDropdown — reusable multi-select checkbox filter.
 * Trigger button shows the label + active-count badge; opens a portaled popover
 * (escapes settings overflow/containment) with a checkbox per option and
 * select-all / clear actions. Closes on outside click or Escape.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

export type FilterOption = { value: string; label: string };

type FilterDropdownProps = {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
};

type MenuPos = { left: number; top: number; minWidth: number };

function FilterDropdown({ label, options, selected, onChange }: FilterDropdownProps) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Anchor the popover under the trigger, clamped to the viewport (flips up when
  // there isn't room below).
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const menuW = Math.max(200, r.width);
    let left = r.left;
    if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
    if (left < 8) left = 8;

    const estHeight = Math.min(340, options.length * 36 + 52);
    let top = r.bottom + 4;
    if (top + estHeight > window.innerHeight - 8) {
      const above = r.top - 4 - estHeight;
      top = above > 8 ? above : Math.max(8, window.innerHeight - estHeight - 8);
    }
    setPos({ left, top, minWidth: menuW });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (triggerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onEsc);
    });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  function toggle(value: string) {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  }

  const count = selected.length;

  return (
    <div className="filter-dropdown">
      <button
        ref={triggerRef}
        type="button"
        className={`filter-dropdown-trigger${count > 0 ? " active" : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="filter-dropdown-label">{label}</span>
        {count > 0 && <span className="filter-dropdown-badge">{count}</span>}
        <span className="filter-dropdown-caret" aria-hidden="true">▾</span>
      </button>

      {open && pos &&
        createPortal(
          <div
            ref={menuRef}
            className="filter-dropdown-menu"
            style={{ left: pos.left, top: pos.top, minWidth: pos.minWidth }}
          >
            <div className="filter-dropdown-actions">
              <button type="button" onClick={() => onChange(options.map((o) => o.value))}>
                {t("filterSelectAll")}
              </button>
              <button type="button" onClick={() => onChange([])} disabled={count === 0}>
                {t("filterClear")}
              </button>
            </div>
            {options.map((opt) => {
              const checked = selected.includes(opt.value);
              return (
                <button
                  key={opt.value}
                  type="button"
                  className={`filter-dropdown-option${checked ? " checked" : ""}`}
                  onClick={() => toggle(opt.value)}
                >
                  <span className="filter-dropdown-check" aria-hidden="true">
                    {checked ? "✓" : ""}
                  </span>
                  <span className="filter-dropdown-option-label">{opt.label}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

export default FilterDropdown;
