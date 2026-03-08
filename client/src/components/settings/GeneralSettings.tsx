/**
 * GeneralSettings — Discord "Windows Ayarları" karşılığı.
 *
 * Sadece Electron ortamında görünür. Üç toggle:
 * 1. Başlangıçta Aç — Windows login'de uygulamayı otomatik başlat
 * 2. Simge Durumuna Küçültülmüş Başlat — pencere gizli başlar (tray'de)
 * 3. Kapat Düğmesi Tray'e Küçült — X butonuna basınca kapanma yerine tray'e git
 *
 * Ayarlar Electron main process'te %APPDATA%/mqvi/app-settings.json'da saklanır.
 * IPC ile get/set yapılır — renderer localStorage kullanmaz çünkü bu ayarlar
 * main process'te renderer yüklenmeden önce okunmalıdır (örn: startMinimized).
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

/** Electron main process'ten gelen ayar yapısı */
interface AppSettings {
  openAtLogin: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
}

/** Tek bir toggle satırı — başlık, açıklama ve switch */
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

  // İlk yüklemede mevcut ayarları Electron main process'ten al
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

  /** Tek bir ayarı güncelle — hem local state hem Electron main process */
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
