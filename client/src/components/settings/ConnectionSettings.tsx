/**
 * ConnectionSettings — Server connection settings for Electron desktop app.
 *
 * Only rendered in Electron mode (isElectron() check in SettingsNav).
 * Allows users to change the server URL for self-hosted instances.
 *
 * CSS classes: .settings-section, .settings-section-title, .conn-*
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { SERVER_URL } from "../../utils/constants";

/** Default server URL — used as placeholder and reset target */
const DEFAULT_SERVER_URL = "https://mqvi.net";

function ConnectionSettings() {
  const { t } = useTranslation("settings");
  const [serverUrl, setServerUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("mqvi_server_url");
    setServerUrl(stored || SERVER_URL || DEFAULT_SERVER_URL);
  }, []);

  function handleUrlChange(value: string) {
    setServerUrl(value);
    setTestResult(null);

    const current = localStorage.getItem("mqvi_server_url") || SERVER_URL || DEFAULT_SERVER_URL;
    setHasChanges(value !== current);
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const url = serverUrl.replace(/\/$/, "");
      const response = await fetch(`${url}/api/health`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      setTestResult(response.ok ? "success" : "error");
    } catch {
      setTestResult("error");
    } finally {
      setTesting(false);
    }
  }

  async function handleSaveAndRestart() {
    const url = serverUrl.replace(/\/$/, "");
    localStorage.setItem("mqvi_server_url", url);

    // Electron API ile uygulamayı yeniden başlat
    try {
      await window.electronAPI?.relaunch();
    } catch {
      // Fallback: sayfayı yeniden yükle
      window.location.reload();
    }
  }

  function handleResetToDefault() {
    setServerUrl(DEFAULT_SERVER_URL);
    setTestResult(null);

    const current = localStorage.getItem("mqvi_server_url") || SERVER_URL || DEFAULT_SERVER_URL;
    setHasChanges(DEFAULT_SERVER_URL !== current);
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("connection")}</h2>

      {/* Current connection info */}
      <div className="conn-current">
        <span className="conn-current-label">{t("currentConnection")}:</span>
        <span className="conn-current-url">{SERVER_URL || DEFAULT_SERVER_URL}</span>
      </div>

      {/* Server URL input */}
      <div className="conn-field">
        <label className="conn-label">{t("serverUrl")}</label>
        <p className="conn-desc">{t("serverUrlDesc")}</p>
        <input
          type="url"
          className="conn-input"
          value={serverUrl}
          onChange={(e) => handleUrlChange(e.target.value)}
          placeholder={t("serverUrlPlaceholder")}
          spellCheck={false}
        />
      </div>

      {/* Action buttons */}
      <div className="conn-actions">
        <button
          className="conn-btn conn-btn-secondary"
          onClick={handleTestConnection}
          disabled={testing || !serverUrl}
        >
          {testing ? t("connectionTesting") : t("testConnection")}
        </button>

        <button
          className="conn-btn conn-btn-secondary"
          onClick={handleResetToDefault}
        >
          {t("resetToDefault")}
        </button>

        <button
          className="conn-btn conn-btn-primary"
          onClick={handleSaveAndRestart}
          disabled={!hasChanges}
        >
          {t("saveAndRestart")}
        </button>
      </div>

      {/* Test result */}
      {testResult === "success" && (
        <p className="conn-result conn-result-success">{t("connectionSuccess")}</p>
      )}
      {testResult === "error" && (
        <p className="conn-result conn-result-error">{t("connectionFailed")}</p>
      )}

      {/* Restart warning */}
      {hasChanges && (
        <p className="conn-restart-warning">{t("restartRequired")}</p>
      )}
    </div>
  );
}

export default ConnectionSettings;
