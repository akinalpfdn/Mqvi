/**
 * PermissionToggle — Tek bir permission checkbox'ı.
 *
 * Rol ayarları panelinde her yetki için bir toggle gösterilir.
 * Label, açıklama ve disabled durumu (admin gibi tehlikeli yetkiler için uyarı).
 */

import { useTranslation } from "react-i18next";

type PermissionToggleProps = {
  /** Permission bit değeri (1, 2, 4, 8, ...) */
  permBit: number;
  /** i18n label key'i (settings namespace'den) */
  labelKey: string;
  /** i18n description key'i */
  descKey: string;
  /** Tehlikeli yetki mi? (Admin gibi — uyarı gösterilir) */
  isChecked: boolean;
  /** Toggle callback */
  onChange: (permBit: number, checked: boolean) => void;
  /** Uyarı mesajı key'i (opsiyonel) */
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
    <div className="flex items-start gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-surface-hover">
      {/* Checkbox */}
      <div className="pt-0.5">
        <button
          onClick={() => onChange(permBit, !isChecked)}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
            isChecked
              ? "border-brand bg-brand"
              : "border-text-muted bg-transparent"
          }`}
        >
          {isChecked && (
            <svg
              className="h-3.5 w-3.5 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
          )}
        </button>
      </div>

      {/* Label + Description */}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-primary">{t(labelKey)}</p>
        <p className="mt-0.5 text-xs text-text-muted">{t(descKey)}</p>
        {warningKey && isChecked && (
          <p className="mt-1 text-xs font-medium text-warning">
            {t(warningKey)}
          </p>
        )}
      </div>
    </div>
  );
}

export default PermissionToggle;
