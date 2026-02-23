/**
 * AppearanceSettings — Tema seçim UI'ı.
 *
 * 5 tema kartı gösterir, her birinde:
 * - 3 renk swatch (ön izleme)
 * - Tema adı + açıklama (i18n)
 * - Aktif tema vurgusu (primary border)
 *
 * Tema değiştirme: settingsStore.setTheme() çağırır → applyTheme() +
 * localStorage persist otomatik yapılır.
 *
 * CSS class'ları: .theme-grid, .theme-card, .theme-card-active,
 * .theme-swatches, .theme-swatch, .theme-card-name, .theme-card-desc
 */

import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { THEMES, THEME_ORDER, type ThemeId } from "../../styles/themes";

function AppearanceSettings() {
  const { t } = useTranslation("settings");
  const themeId = useSettingsStore((s) => s.themeId);
  const setTheme = useSettingsStore((s) => s.setTheme);

  function handleSelectTheme(id: ThemeId) {
    setTheme(id);
  }

  return (
    <div>
      <h2 className="settings-section-title">{t("themeTitle")}</h2>
      <p className="theme-section-desc">{t("themeDescription")}</p>

      <div className="theme-grid">
        {THEME_ORDER.map((id) => {
          const theme = THEMES[id];
          const isActive = id === themeId;

          return (
            <button
              key={id}
              className={`theme-card${isActive ? " theme-card-active" : ""}`}
              onClick={() => handleSelectTheme(id)}
              type="button"
            >
              {/* Swatch ön izleme — 3 renk dairesi */}
              <div className="theme-swatches">
                {theme.swatches.map((color, i) => (
                  <span
                    key={i}
                    className="theme-swatch"
                    style={{ background: color }}
                  />
                ))}
              </div>

              {/* Tema bilgileri */}
              <span className="theme-card-name">{t(theme.nameKey)}</span>
              <span className="theme-card-desc">{t(theme.descKey)}</span>

              {/* Aktif göstergesi */}
              {isActive && <span className="theme-card-check">&#10003;</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default AppearanceSettings;
