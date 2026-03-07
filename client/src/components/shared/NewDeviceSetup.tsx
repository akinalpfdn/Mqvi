/**
 * NewDeviceSetup — E2EE cihaz kurulum modal'ı (blocking).
 *
 * e2eeStore.initStatus === "needs_setup" olduğunda gösterilir.
 * Kullanıcı E2EE anahtarlarını oluşturana veya kurtarma parolasıyla
 * geri yükleyene kadar uygulama kullanılamaz.
 *
 * Akış (hasRecoveryBackup durumuna göre):
 *
 * A) Yedek VAR (hasRecoveryBackup = true):
 *    - Birincil: "Kurtarma Parolasıyla Geri Yükle" (eski mesajlara erişim)
 *    - İkincil: "Yeni Anahtarlar Oluştur" (uyarı ile — eski mesajlar kaybolur)
 *    → Yeni anahtarlar seçilirse onay adımı gösterilir
 *
 * B) Yedek YOK (ilk cihaz / ilk kurulum):
 *    - Sadece "Yeni Anahtarlar Oluştur" (normal akış, uyarı yok)
 *
 * View state machine:
 * - "choice": İlk ekran — seçenekler
 * - "restore": Kurtarma parolası giriş ekranı
 * - "confirmNewKeys": Yeni anahtar oluşturma onay ekranı (yedek varsa)
 *
 * CSS class'ları: .modal-backdrop, .modal-card, .modal-title
 * + e2ee-specific: .e2ee-setup-*
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useToastStore } from "../../stores/toastStore";

type SetupView = "choice" | "restore" | "confirmNewKeys" | "setRecoveryPassword";

function NewDeviceSetup() {
  const { t } = useTranslation("e2ee");
  const userId = useAuthStore((s) => s.user?.id);
  const setupNewDevice = useE2EEStore((s) => s.setupNewDevice);
  const restoreFromRecovery = useE2EEStore((s) => s.restoreFromRecovery);
  const completeRecoverySetup = useE2EEStore((s) => s.completeRecoverySetup);
  const isGeneratingKeys = useE2EEStore((s) => s.isGeneratingKeys);
  const hasRecoveryBackup = useE2EEStore((s) => s.hasRecoveryBackup);
  const initStatus = useE2EEStore((s) => s.initStatus);
  const initError = useE2EEStore((s) => s.initError);
  const addToast = useToastStore((s) => s.addToast);

  // needs_recovery_password → doğrudan recovery password formu göster
  const initialView: SetupView = initStatus === "needs_recovery_password"
    ? "setRecoveryPassword"
    : "choice";
  const [view, setView] = useState<SetupView>(initialView);
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [recoveryPasswordConfirm, setRecoveryPasswordConfirm] = useState("");
  const [isRestoring, setIsRestoring] = useState(false);
  const [isSavingRecovery, setIsSavingRecovery] = useState(false);

  /** Yeni anahtarlar oluştur */
  async function handleGenerateKeys() {
    if (!userId || isGeneratingKeys) return;
    await setupNewDevice(userId);
  }

  /** Kurtarma parolasıyla geri yükle */
  async function handleRestore() {
    if (!recoveryPassword.trim() || isRestoring) return;

    setIsRestoring(true);
    const success = await restoreFromRecovery(recoveryPassword.trim());
    setIsRestoring(false);

    if (success) {
      addToast("success", t("restoreSuccess"));
    }
  }

  /** Zorunlu recovery password kaydet (ilk kurulum) */
  async function handleSaveRecoveryPassword() {
    if (!recoveryPassword.trim() || !recoveryPasswordConfirm.trim() || isSavingRecovery) return;
    if (recoveryPassword !== recoveryPasswordConfirm) {
      addToast("error", t("recoveryPasswordMismatch"));
      return;
    }

    setIsSavingRecovery(true);
    try {
      await completeRecoverySetup(recoveryPassword.trim());
      addToast("success", t("recoveryPasswordSet"));
    } catch {
      addToast("error", t("recoveryPasswordSaveError"));
    }
    setIsSavingRecovery(false);
  }

  const isLoading = isGeneratingKeys || isRestoring || isSavingRecovery;

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
                  {/* Yedek var — kurtarma birincil, yeni anahtar ikincil */}
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
                  {/* Yedek yok — kurtarma birincil, yeni anahtar ikincil */}
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
            {/* Onay ekranı — yedek varken yeni anahtar oluşturma uyarısı */}
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

        {view === "setRecoveryPassword" && (
          <>
            {/* Lock icon */}
            <div className="e2ee-setup-icon">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>

            <div className="modal-header">
              <h2 className="modal-title">{t("recoveryPasswordTitle")}</h2>
            </div>

            <p className="e2ee-setup-description">
              {t("mandatoryRecoveryDescription")}
            </p>

            <div className="e2ee-setup-hint">
              {t("mandatoryRecoveryHint")}
            </div>

            {initError && (
              <p className="e2ee-setup-error">{initError}</p>
            )}

            <div className="e2ee-setup-fields">
              <div className="e2ee-setup-field">
                <input
                  type="password"
                  value={recoveryPassword}
                  onChange={(e) => setRecoveryPassword(e.target.value)}
                  placeholder={t("recoveryPasswordPlaceholder")}
                  className="settings-input"
                  autoFocus
                  autoComplete="new-password"
                />
              </div>

              <div className="e2ee-setup-field">
                <input
                  type="password"
                  value={recoveryPasswordConfirm}
                  onChange={(e) => setRecoveryPasswordConfirm(e.target.value)}
                  placeholder={t("recoveryPasswordConfirmPlaceholder")}
                  className="settings-input"
                  autoComplete="new-password"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSaveRecoveryPassword();
                  }}
                />
              </div>
            </div>

            <div className="e2ee-setup-actions">
              <button
                onClick={handleSaveRecoveryPassword}
                disabled={!recoveryPassword.trim() || !recoveryPasswordConfirm.trim() || isLoading}
                className="settings-btn e2ee-setup-btn-primary"
              >
                {isSavingRecovery ? t("restoring") : t("setRecoveryPassword")}
              </button>
            </div>
          </>
        )}

      </div>
    </div>
  );
}

export default NewDeviceSetup;
