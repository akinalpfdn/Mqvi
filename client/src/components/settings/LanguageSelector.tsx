/**
 * LanguageSelector — Dil seçim dropdown'ı.
 *
 * İki dil destekleniyor: English (en), Türkçe (tr).
 *
 * Dil değişikliği iki yerde uygulanır:
 * 1. Frontend: i18next.changeLanguage() → UI anında güncellenir
 * 2. Backend: updateProfile({ language }) → DB'ye kaydedilir
 *
 * Neden ikisi birlikte?
 * - Frontend değişikliği anında UX sağlar (kullanıcı beklemesin)
 * - Backend sync sayesinde farklı cihazda/oturumda tercih korunur
 * - Backend hatası durumunda frontend zaten değişmiştir —
 *   sonraki oturum DB'deki değeri yükleyecektir (eventual consistency)
 */

import { useTranslation } from "react-i18next";

type LanguageSelectorProps = {
  /** Mevcut dil kodu — "en" veya "tr" */
  currentLanguage: string;
  /** Dil değiştiğinde çağrılır — parent component backend sync yapar */
  onChange: (language: string) => void;
};

/** Desteklenen diller — label'lar i18n key olarak settings.json'dan çekilir */
const LANGUAGES = [
  { code: "en", labelKey: "english" },
  { code: "tr", labelKey: "turkish" },
] as const;

function LanguageSelector({ currentLanguage, onChange }: LanguageSelectorProps) {
  const { t } = useTranslation("settings");

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium text-text-primary">
        {t("language")}
      </label>
      <p className="text-xs text-text-muted">{t("languageDescription")}</p>
      <select
        value={currentLanguage}
        onChange={(e) => onChange(e.target.value)}
        className="w-full max-w-xs cursor-pointer rounded-md bg-input px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:bg-input-focus"
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
