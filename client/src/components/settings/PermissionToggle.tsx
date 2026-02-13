/**
 * PermissionToggle — Tek bir permission checkbox'ı.
 *
 * CSS class'ları: .permission-toggle, .permission-toggle-checkbox,
 * .permission-toggle-checkbox.checked, .permission-toggle-check,
 * .permission-toggle-label, .permission-toggle-desc, .permission-toggle-warn
 */

import { useTranslation } from "react-i18next";

type PermissionToggleProps = {
  permBit: number;
  labelKey: string;
  descKey: string;
  isChecked: boolean;
  onChange: (permBit: number, checked: boolean) => void;
  warningKey?: string;
};

function PermissionToggle({
  permBit,
  labelKey,
  descKey,
  isChecked,
  onChange,
  warningKey,
}: PermissionToggleProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="permission-toggle">
      {/* Checkbox */}
      <button
        onClick={() => onChange(permBit, !isChecked)}
        className={`permission-toggle-checkbox${isChecked ? " checked" : ""}`}
      >
        {isChecked && (
          <svg className="permission-toggle-check" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </button>

      {/* Label + Description */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p className="permission-toggle-label">{t(labelKey)}</p>
        <p className="permission-toggle-desc">{t(descKey)}</p>
        {warningKey && isChecked && (
          <p className="permission-toggle-warn">{t(warningKey)}</p>
        )}
      </div>
    </div>
  );
}

export default PermissionToggle;
