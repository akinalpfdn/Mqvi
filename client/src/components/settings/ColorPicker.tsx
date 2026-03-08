/**
 * ColorPicker — Rol renk seçici.
 *
 * Üç parçalı seçim:
 * 1. Preset renk grid'i (20 renk, hızlı seçim)
 * 2. Hex input (manuel giriş)
 * 3. Popover color picker butonu (react-colorful — tam spektrum, dark tema uyumlu)
 *
 * react-colorful: ~2KB, zero-dependency, CSS ile tam stillenebilir.
 * Native <input type="color"> yerine kullanılıyor çünkü OS picker'ı
 * uygulamanın dark temasıyla uyuşmuyor.
 *
 * CSS class'ları: .color-picker, .color-swatch, .color-swatch.selected,
 * .color-hex-input, .color-native-btn, .color-popover
 */

import { useState, useRef, useEffect } from "react";
import { HexColorPicker } from "react-colorful";

const PRESET_COLORS = [
  "#1ABC9C", "#2ECC71", "#3498DB", "#9B59B6", "#E91E63",
  "#F1C40F", "#E67E22", "#E74C3C", "#95A5A6", "#607D8B",
  "#11806A", "#1F8B4C", "#206694", "#71368A", "#AD1457",
  "#C27C0E", "#A84300", "#992D22", "#979C9F", "#546E7A",
] as const;

type ColorPickerProps = {
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
};

function ColorPicker({ value, onChange, disabled }: ColorPickerProps) {
  const [showPopover, setShowPopover] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Click-outside: popover dışına tıklanınca kapat
  useEffect(() => {
    if (!showPopover) return;
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowPopover(false);
      }
    }
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showPopover]);

  return (
    <div>
      {/* Preset renkler grid'i */}
      <div className="color-picker">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            onClick={() => !disabled && onChange(color)}
            className={`color-swatch${value.toUpperCase() === color ? " selected" : ""}`}
            style={{ backgroundColor: color, opacity: disabled ? 0.5 : 1 }}
            disabled={disabled}
          />
        ))}
      </div>

      {/* Hex input + popover picker */}
      <div className="color-hex-row">
        <div
          className="color-hex-preview"
          style={{ backgroundColor: value || "var(--t1)" }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => !disabled && onChange(e.target.value)}
          placeholder="#99AAB5"
          maxLength={7}
          className="color-hex-input"
          disabled={disabled}
        />
        {/* Popover color picker toggle */}
        <div className="color-popover-anchor" ref={popoverRef}>
          <button
            type="button"
            className="color-native-btn"
            onClick={() => !disabled && setShowPopover((p) => !p)}
            disabled={disabled}
            title="Color picker"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a10 10 0 0 0 0 20 2 2 0 0 0 2-2v-1a2 2 0 0 1 2-2h1a2 2 0 0 0 2-2 10 10 0 0 0-7-13Z" />
              <circle cx="8" cy="10" r="1.5" fill="currentColor" />
              <circle cx="12" cy="7" r="1.5" fill="currentColor" />
              <circle cx="16" cy="10" r="1.5" fill="currentColor" />
              <circle cx="9" cy="14" r="1.5" fill="currentColor" />
            </svg>
          </button>
          {showPopover && (
            <div className="color-popover">
              <HexColorPicker
                color={value || "#99AAB5"}
                onChange={(c) => onChange(c.toUpperCase())}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ColorPicker;
