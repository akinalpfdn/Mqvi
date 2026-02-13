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
};

function ColorPicker({ value, onChange }: ColorPickerProps) {
  return (
    <div>
      {/* Preset renkler grid'i */}
      <div className="color-picker">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            onClick={() => onChange(color)}
            className={`color-swatch${value.toUpperCase() === color ? " selected" : ""}`}
            style={{ backgroundColor: color }}
          />
        ))}
      </div>

      {/* Hex input */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            border: "1px solid var(--b1)",
            backgroundColor: value || "#99AAB5",
            flexShrink: 0,
          }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#99AAB5"
          maxLength={7}
          className="color-hex-input"
        />
      </div>
    </div>
  );
}

export default ColorPicker;
