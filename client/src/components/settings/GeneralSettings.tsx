/**
 * GeneralSettings — Electron-only desktop settings (auto-launch, start minimized, close-to-tray).
 * Persisted in main process via IPC (%APPDATA%/mqvi/app-settings.json).
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

/** Settings shape from Electron main process */
interface AppSettings {
  openAtLogin: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
}

/** Single toggle row with label, description and switch */
function SettingToggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="general-setting-row">
      <div className="general-setting-info">
        <span className="general-setting-label">{label}</span>
        <span className="general-setting-desc">{description}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`toggle-switch${checked ? " toggle-switch-on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle-switch-thumb" />
      </button>
    </div>
  );
}

function GeneralSettings() {
  const { t } = useTranslation("settings");
  const [settings, setSettings] = useState<AppSettings>({
    openAtLogin: false,
    startMinimized: false,
    closeToTray: true,
  });
  const [loaded, setLoaded] = useState(false);

  // Load current settings from Electron main process on mount
  useEffect(() => {
    async function load() {
      const current = await window.electronAPI?.getAppSettings();
      if (current) {
        setSettings(current);
      }
      setLoaded(true);
    }
    load();
  }, []);

  /** Update a single setting — local state + Electron main process */
  async function handleChange(key: keyof AppSettings, value: boolean) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    await window.electronAPI?.setAppSetting(key, value);
  }

  if (!loaded) return null;

  return (
    <div>
      <h2 className="settings-section-title">{t("desktopSettings")}</h2>

      <div className="general-settings-list">
        <SettingToggle
          label={t("openAtLogin")}
          description={t("openAtLoginDesc")}
          checked={settings.openAtLogin}
          onChange={(v) => handleChange("openAtLogin", v)}
        />

        <SettingToggle
          label={t("startMinimized")}
          description={t("startMinimizedDesc")}
          checked={settings.startMinimized}
          onChange={(v) => handleChange("startMinimized", v)}
        />

        <SettingToggle
          label={t("closeToTray")}
          description={t("closeToTrayDesc")}
          checked={settings.closeToTray}
          onChange={(v) => handleChange("closeToTray", v)}
        />
      </div>
    </div>
  );
}

export default GeneralSettings;
