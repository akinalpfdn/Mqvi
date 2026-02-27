/**
 * SecuritySettings — Güvenlik ayarları sekmesi.
 *
 * Şifre değiştirme formu:
 * - Mevcut şifre (doğrulama için)
 * - Yeni şifre
 * - Yeni şifre tekrar (client-side eşleşme kontrolü)
 *
 * CSS class'ları: .settings-section-title, .settings-field,
 * .settings-label, .settings-input, .settings-btn
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import * as authApi from "../../api/auth";

function SecuritySettings() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  /** Form dolu mu — tüm alanlar girilmiş olmalı */
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length > 0 &&
    confirmPassword.length > 0 &&
    !isSaving;

  async function handleSubmit() {
    if (!canSubmit) return;

    // Client-side validation
    if (newPassword.length < 6) {
      addToast("error", t("passwordTooShort"));
      return;
    }

    if (newPassword !== confirmPassword) {
      addToast("error", t("passwordMismatch"));
      return;
    }

    if (currentPassword === newPassword) {
      addToast("error", t("passwordSameAsOld"));
      return;
    }

    setIsSaving(true);
    try {
      const res = await authApi.changePassword(currentPassword, newPassword);
      if (res.success) {
        addToast("success", t("passwordChanged"));
        // Form reset — başarılı değişim sonrası alanları temizle
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } else {
        // Backend error mesajına göre uygun i18n key seç
        const errMsg = res.error ?? "";
        if (errMsg.includes("incorrect") || errMsg.includes("unauthorized")) {
          addToast("error", t("wrongCurrentPassword"));
        } else if (errMsg.includes("at least 6")) {
          addToast("error", t("passwordTooShort"));
        } else if (errMsg.includes("different")) {
          addToast("error", t("passwordSameAsOld"));
        } else {
          addToast("error", t("passwordChangeError"));
        }
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("security")}</h2>

      <h3 className="settings-section-subtitle">{t("changePassword")}</h3>

      {/* Mevcut Şifre */}
      <div className="settings-field">
        <label htmlFor="currentPassword" className="settings-label">
          {t("currentPassword")}
        </label>
        <input
          id="currentPassword"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder={t("currentPasswordPlaceholder")}
          className="settings-input"
          autoComplete="current-password"
        />
      </div>

      {/* Yeni Şifre */}
      <div className="settings-field">
        <label htmlFor="newPassword" className="settings-label">
          {t("newPassword")}
        </label>
        <input
          id="newPassword"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder={t("newPasswordPlaceholder")}
          className="settings-input"
          autoComplete="new-password"
        />
      </div>

      {/* Yeni Şifre Tekrar */}
      <div className="settings-field">
        <label htmlFor="confirmNewPassword" className="settings-label">
          {t("confirmNewPassword")}
        </label>
        <input
          id="confirmNewPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder={t("confirmNewPasswordPlaceholder")}
          className="settings-input"
          autoComplete="new-password"
        />
      </div>

      {/* Submit */}
      <div style={{ marginTop: 16 }}>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="settings-btn"
        >
          {isSaving ? t("changePassword") + "..." : t("changePassword")}
        </button>
      </div>
    </div>
  );
}

export default SecuritySettings;
