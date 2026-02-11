/**
 * ColorPicker — Rol renk seçici.
 *
 * Discord tarzı: Önceden tanımlı renkler + hex input.
 * Seçilen renk onClick ile parent'a iletilir.
 */

/** Discord'un rol renk paleti */
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
      <div className="grid grid-cols-10 gap-1.5">
        {PRESET_COLORS.map((color) => (
          <button
            key={color}
            onClick={() => onChange(color)}
            className={`h-7 w-7 rounded-md transition-transform hover:scale-110 ${
              value.toUpperCase() === color
                ? "ring-2 ring-white ring-offset-2 ring-offset-background-floating"
                : ""
            }`}
            style={{ backgroundColor: color }}
          />
        ))}
      </div>

      {/* Hex input */}
      <div className="mt-3 flex items-center gap-2">
        <div
          className="h-8 w-8 shrink-0 rounded-md border border-background-tertiary"
          style={{ backgroundColor: value || "#99AAB5" }}
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#99AAB5"
          maxLength={7}
          className="h-8 flex-1 rounded-md bg-input px-2.5 text-sm text-text-primary outline-none transition-colors focus:bg-input-focus"
        />
      </div>
    </div>
  );
}

export default ColorPicker;
