/**
 * RecoveryPasswordPrompt — Non-blocking modal shown when E2EE is active.
 *
 * Two modes:
 * 1. Backup exists → Offer to restore old keys (access previous encrypted messages)
 *    or continue with new keys.
 * 2. No backup → Prompt to set a recovery password for key protection.
 *
 * Always dismissible — user can handle it later from Settings > Encryption.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useToastStore } from "../../stores/toastStore";

type PromptView = "main" | "restore" | "setPassword";

function RecoveryPasswordPrompt() {
  const { t } = useTranslation("e2ee");
  const hasRecoveryBackup = useE2EEStore((s) => s.hasRecoveryBackup);
  const restoreFromRecovery = useE2EEStore((s) => s.restoreFromRecovery);
  const completeRecoverySetup = useE2EEStore((s) => s.completeRecoverySetup);
  const dismissRecoveryPrompt = useE2EEStore((s) => s.dismissRecoveryPrompt);
  const addToast = useToastStore((s) => s.addToast);

  const [view, setView] = useState<PromptView>("main");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function handleRestore() {
    if (!password.trim() || isLoading) return;

    setIsLoading(true);
    const success = await restoreFromRecovery(password.trim());
    setIsLoading(false);

    if (success) {
      addToast("success", t("restoreSuccess"));
      dismissRecoveryPrompt();
    } else {
      addToast("error", t("restoreInvalidPassword"));
    }
  }

  async function handleSetPassword() {
    if (!password.trim() || !confirmPassword.trim() || isLoading) return;
    if (password !== confirmPassword) {
      addToast("error", t("recoveryPasswordMismatch"));
      return;
    }

    setIsLoading(true);
    try {
      await completeRecoverySetup(password.trim());
      addToast("success", t("recoveryPasswordSet"));
    } catch {
      addToast("error", t("recoveryPasswordSaveError"));
    }
    setIsLoading(false);
  }

  function resetAndSwitchView(newView: PromptView) {
    setPassword("");
    setConfirmPassword("");
    setView(newView);
  }

  return (
    <div className="modal-backdrop" onClick={dismissRecoveryPrompt}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {/* Lock icon */}
        <div className="e2ee-setup-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>

        {/* ─── Main View ─── */}
        {view === "main" && (
          <>
            <div className="modal-header">
              <h2 className="modal-title">{t("recoveryPromptTitle")}</h2>
            </div>

            <p className="e2ee-setup-description">
              {hasRecoveryBackup
                ? t("recoveryPromptDescriptionRestore")
                : t("recoveryPromptDescription")}
            </p>

            <div className="e2ee-setup-hint">
              {t("recoveryPromptHint")}
            </div>

            <div className="e2ee-setup-actions">
              {hasRecoveryBackup ? (
                <>
                  <button
                    onClick={() => resetAndSwitchView("restore")}
                    className="settings-btn e2ee-setup-btn-primary"
                  >
                    {t("restoreFromRecovery")}
                  </button>
                  <button
                    onClick={() => resetAndSwitchView("setPassword")}
                    className="settings-btn e2ee-setup-btn-secondary"
                  >
                    {t("recoveryPromptContinueNewKeys")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => resetAndSwitchView("setPassword")}
                    className="settings-btn e2ee-setup-btn-primary"
                  >
                    {t("recoveryPromptSetPassword")}
                  </button>
                  <button
                    onClick={dismissRecoveryPrompt}
                    className="settings-btn e2ee-setup-btn-secondary"
                  >
                    {t("recoveryPromptDismiss")}
                  </button>
                </>
              )}
            </div>
          </>
        )}

        {/* ─── Restore View ─── */}
        {view === "restore" && (
          <>
            <div className="modal-header">
              <h2 className="modal-title">{t("restoreTitle")}</h2>
            </div>

            <p className="e2ee-setup-description">{t("restoreDescription")}</p>

            <div className="e2ee-setup-field">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
                disabled={!password.trim() || isLoading}
                className="settings-btn e2ee-setup-btn-primary"
              >
                {isLoading ? t("restoring") : t("restoreButton")}
              </button>
              <button
                onClick={() => resetAndSwitchView("main")}
                disabled={isLoading}
                className="settings-btn e2ee-setup-btn-secondary"
              >
                {t("setupBackToChoice")}
              </button>
            </div>
          </>
        )}

        {/* ─── Set Password View ─── */}
        {view === "setPassword" && (
          <>
            <div className="modal-header">
              <h2 className="modal-title">{t("recoveryPasswordTitle")}</h2>
            </div>

            <p className="e2ee-setup-description">
              {t("recoveryPasswordDescription")}
            </p>

            <div className="e2ee-setup-fields">
              <div className="e2ee-setup-field">
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("recoveryPasswordPlaceholder")}
                  className="settings-input"
                  autoFocus
                  autoComplete="new-password"
                />
              </div>

              <div className="e2ee-setup-field">
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={t("recoveryPasswordConfirmPlaceholder")}
                  className="settings-input"
                  autoComplete="new-password"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSetPassword();
                  }}
                />
              </div>
            </div>

            <div className="e2ee-setup-actions">
              <button
                onClick={handleSetPassword}
                disabled={!password.trim() || !confirmPassword.trim() || isLoading}
                className="settings-btn e2ee-setup-btn-primary"
              >
                {isLoading ? t("restoring") : t("setRecoveryPassword")}
              </button>
              <button
                onClick={() => resetAndSwitchView("main")}
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

export default RecoveryPasswordPrompt;
