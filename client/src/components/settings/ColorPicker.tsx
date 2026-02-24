/**
 * ColorPicker — Rol renk seçici.
 *
 * CSS class'ları: .color-picker, .color-swatch, .color-swatch.selected,
 * .color-hex-input
 */

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

      {/* Hex input */}
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
      </div>
    </div>
  );
}

export default ColorPicker;
