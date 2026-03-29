/**
 * RecoveryPasswordPrompt — Non-blocking modal prompting the user to set
 * a recovery password when E2EE is first activated in a conversation.
 *
 * Dismissible — user can choose "Later" and set it from Settings > Encryption.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useToastStore } from "../../stores/toastStore";

function RecoveryPasswordPrompt() {
  const { t } = useTranslation("e2ee");
  const completeRecoverySetup = useE2EEStore((s) => s.completeRecoverySetup);
  const dismissRecoveryPrompt = useE2EEStore((s) => s.dismissRecoveryPrompt);
  const addToast = useToastStore((s) => s.addToast);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  async function handleSave() {
    if (!password.trim() || !confirmPassword.trim() || isSaving) return;
    if (password !== confirmPassword) {
      addToast("error", t("recoveryPasswordMismatch"));
      return;
    }

    setIsSaving(true);
    try {
      await completeRecoverySetup(password.trim());
      addToast("success", t("recoveryPasswordSet"));
    } catch {
      addToast("error", t("recoveryPasswordSaveError"));
    }
    setIsSaving(false);
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

        <div className="modal-header">
          <h2 className="modal-title">{t("recoveryPromptTitle")}</h2>
        </div>

        <p className="e2ee-setup-description">
          {t("recoveryPromptDescription")}
        </p>

        <div className="e2ee-setup-hint">
          {t("recoveryPromptHint")}
        </div>

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
                if (e.key === "Enter") handleSave();
              }}
            />
          </div>
        </div>

        <div className="e2ee-setup-actions">
          <button
            onClick={handleSave}
            disabled={!password.trim() || !confirmPassword.trim() || isSaving}
            className="settings-btn e2ee-setup-btn-primary"
          >
            {isSaving ? t("restoring") : t("recoveryPromptSetPassword")}
          </button>

          <button
            onClick={dismissRecoveryPrompt}
            disabled={isSaving}
            className="settings-btn e2ee-setup-btn-secondary"
          >
            {t("recoveryPromptDismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default RecoveryPasswordPrompt;
