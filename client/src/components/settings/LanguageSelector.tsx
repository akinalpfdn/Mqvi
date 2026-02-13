/**
 * LanguageSelector — Dil seçim dropdown'ı.
 *
 * CSS class'ları: .settings-field, .settings-label, .settings-select
 */

import { useTranslation } from "react-i18next";

type LanguageSelectorProps = {
  currentLanguage: string;
  onChange: (language: string) => void;
};

const LANGUAGES = [
  { code: "en", labelKey: "english" },
  { code: "tr", labelKey: "turkish" },
] as const;

function LanguageSelector({ currentLanguage, onChange }: LanguageSelectorProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="settings-field">
      <label className="settings-label">{t("language")}</label>
      <p style={{ fontSize: 11, color: "var(--t2)", marginBottom: 6 }}>{t("languageDescription")}</p>
      <select
        value={currentLanguage}
        onChange={(e) => onChange(e.target.value)}
        className="settings-select"
      >
        {LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {t(lang.labelKey)}
          </option>
        ))}
      </select>
    </div>
  );
}

export default LanguageSelector;
