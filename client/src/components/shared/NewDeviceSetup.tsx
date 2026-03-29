/**
 * NewDeviceSetup — Blocking E2EE device setup modal.
 *
 * Shown when e2eeStore.initStatus === "needs_setup".
 * Views: "choice" -> "restore" (recovery password) or "confirmNewKeys" (warning if backup exists).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useToastStore } from "../../stores/toastStore";

type SetupView = "choice" | "restore" | "confirmNewKeys";

function NewDeviceSetup() {
  const { t } = useTranslation("e2ee");
  const userId = useAuthStore((s) => s.user?.id);
  const setupNewDevice = useE2EEStore((s) => s.setupNewDevice);
  const restoreFromRecovery = useE2EEStore((s) => s.restoreFromRecovery);
  const isGeneratingKeys = useE2EEStore((s) => s.isGeneratingKeys);
  const hasRecoveryBackup = useE2EEStore((s) => s.hasRecoveryBackup);
  const initError = useE2EEStore((s) => s.initError);
  const addToast = useToastStore((s) => s.addToast);

  const [view, setView] = useState<SetupView>("choice");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [isRestoring, setIsRestoring] = useState(false);

  /** Generate new E2EE keys */
  async function handleGenerateKeys() {
    if (!userId || isGeneratingKeys) return;
    await setupNewDevice(userId);
  }

  /** Restore from recovery password */
  async function handleRestore() {
    if (!recoveryPassword.trim() || isRestoring) return;

    setIsRestoring(true);
    const success = await restoreFromRecovery(recoveryPassword.trim());
    setIsRestoring(false);

    if (success) {
      addToast("success", t("restoreSuccess"));
    }
  }

  const isLoading = isGeneratingKeys || isRestoring;

  return (
    <div className="modal-backdrop">
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {view === "choice" && (
          <>
            <div className="modal-header">
              <h2 className="modal-title">{t("setupTitle")}</h2>
            </div>

            <p className="e2ee-setup-description">
              {hasRecoveryBackup
                ? t("setupDescriptionHasBackup")
                : t("setupDescription")}
            </p>

            {initError && (
              <p className="e2ee-setup-error">{initError}</p>
            )}

            <div className="e2ee-setup-actions">
              {hasRecoveryBackup ? (
                <>
                  {/* Backup exists — restore is primary, new keys is secondary */}
                  <button
                    onClick={() => setView("restore")}
                    disabled={isLoading}
                    className="settings-btn e2ee-setup-btn-primary"
                  >
                    {t("restoreFromRecovery")}
                  </button>

                  <button
                    onClick={() => setView("confirmNewKeys")}
                    disabled={isLoading}
                    className="settings-btn e2ee-setup-btn-secondary"
                  >
                    {t("generateNewKeys")}
                  </button>
                </>
              ) : (
                <>
                  {/* No backup — restore is primary, new keys is secondary */}
                  <button
                    onClick={() => setView("restore")}
                    disabled={isLoading}
                    className="settings-btn e2ee-setup-btn-primary"
                  >
                    {t("restoreFromRecovery")}
                  </button>

                  <button
                    onClick={handleGenerateKeys}
                    disabled={isLoading}
                    className="settings-btn e2ee-setup-btn-secondary"
                  >
                    {isGeneratingKeys ? t("generatingKeys") : t("generateNewKeys")}
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {view === "restore" && (
          <>
            <div className="modal-header">
              <h2 className="modal-title">{t("restoreTitle")}</h2>
            </div>

            <p className="e2ee-setup-description">{t("restoreDescription")}</p>

            {initError && (
              <p className="e2ee-setup-error">{initError}</p>
            )}

            <div className="e2ee-setup-field">
              <input
                type="password"
                value={recoveryPassword}
                onChange={(e) => setRecoveryPassword(e.target.value)}
                placeholder={t("recoveryPasswordPlaceholder")}
                className="settings-input"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRestore();
                }}
              />
            </div>

            <div className="e2ee-setup-actions">
              <button
                onClick={handleRestore}
                disabled={!recoveryPassword.trim() || isLoading}
                className="settings-btn e2ee-setup-btn-primary"
              >
                {isRestoring ? t("restoring") : t("restoreButton")}
              </button>

              <button
                onClick={() => {
                  setView("choice");
                  setRecoveryPassword("");
                }}
                disabled={isLoading}
                className="settings-btn e2ee-setup-btn-secondary"
              >
                {t("setupBackToChoice")}
              </button>
            </div>
          </>
        )}

        {view === "confirmNewKeys" && (
          <>
            {/* Confirmation — warn about losing old messages when generating new keys */}
            <div className="modal-header">
              <h2 className="modal-title">{t("generateNewKeys")}</h2>
            </div>

            <p className="e2ee-setup-warning">{t("generateNewKeysWarning")}</p>

            {initError && (
              <p className="e2ee-setup-error">{initError}</p>
            )}

            <div className="e2ee-setup-actions">
              <button
                onClick={handleGenerateKeys}
                disabled={isLoading}
                className="settings-btn e2ee-setup-btn-danger"
              >
                {isGeneratingKeys ? t("generatingKeys") : t("generateNewKeysConfirm")}
              </button>

              <button
                onClick={() => setView("choice")}
                disabled={isLoading}
                className="settings-btn e2ee-setup-btn-secondary"
              >
                {t("setupBackToChoice")}
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}

export default NewDeviceSetup;
