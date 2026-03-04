/**
 * NewDeviceSetup — E2EE cihaz kurulum modal'ı (blocking).
 *
 * e2eeStore.initStatus === "needs_setup" olduğunda gösterilir.
 * Kullanıcı E2EE anahtarlarını oluşturana veya kurtarma parolasıyla
 * geri yükleyene kadar uygulama kullanılamaz.
 *
 * İki seçenek:
 * 1. "Yeni Anahtarlar Oluştur" → setupNewDevice()
 * 2. "Kurtarma Parolasıyla Geri Yükle" → restoreFromRecovery(password)
 *
 * CSS class'ları: .modal-backdrop, .modal-card, .modal-title
 * + e2ee-specific: .e2ee-setup-*
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useToastStore } from "../../stores/toastStore";

/**
 * View state machine:
 * - "choice": İlk ekran — iki seçenek gösterilir
 * - "restore": Kurtarma parolası giriş ekranı
 */
type SetupView = "choice" | "restore";

function NewDeviceSetup() {
  const { t } = useTranslation("e2ee");
  const { t: tSettings } = useTranslation("settings");
  const userId = useAuthStore((s) => s.user?.id);
  const logout = useAuthStore((s) => s.logout);
  const setupNewDevice = useE2EEStore((s) => s.setupNewDevice);
  const restoreFromRecovery = useE2EEStore((s) => s.restoreFromRecovery);
  const isGeneratingKeys = useE2EEStore((s) => s.isGeneratingKeys);
  const initError = useE2EEStore((s) => s.initError);
  const addToast = useToastStore((s) => s.addToast);

  const [view, setView] = useState<SetupView>("choice");
  const [recoveryPassword, setRecoveryPassword] = useState("");
  const [isRestoring, setIsRestoring] = useState(false);

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
    // Hata durumunda initError store'dan okunur ve gösterilir
  }

  const isLoading = isGeneratingKeys || isRestoring;

  return (
    <div className="modal-backdrop">
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {view === "choice" ? (
          <>
            {/* Choice view — iki seçenek */}
            <div className="modal-header">
              <h2 className="modal-title">{t("setupTitle")}</h2>
            </div>

            <p className="e2ee-setup-description">{t("setupDescription")}</p>

            {initError && (
              <p className="e2ee-setup-error">{initError}</p>
            )}

            <div className="e2ee-setup-actions">
              <button
                onClick={handleGenerateKeys}
                disabled={isLoading}
                className="settings-btn e2ee-setup-btn-primary"
              >
                {isGeneratingKeys ? t("generatingKeys") : t("generateNewKeys")}
              </button>

              <button
                onClick={() => setView("restore")}
                disabled={isLoading}
                className="settings-btn e2ee-setup-btn-secondary"
              >
                {t("restoreFromRecovery")}
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Restore view — kurtarma parolası girişi */}
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

        {/* Çıkış butonu — sunucu erişilemezse kullanıcı takılmasın */}
        <button
          onClick={logout}
          disabled={isLoading}
          className="e2ee-setup-logout"
        >
          {tSettings("logOut")}
        </button>
      </div>
    </div>
  );
}

export default NewDeviceSetup;
