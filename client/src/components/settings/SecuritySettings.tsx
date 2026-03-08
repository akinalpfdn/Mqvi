/** SecuritySettings — Email change/remove (with password verification) and password change. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import * as authApi from "../../api/auth";

function SecuritySettings() {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);

  // ─── Email State ───
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [isEmailSaving, setIsEmailSaving] = useState(false);

  // ─── Password State ───
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // ─── Email Handlers ───
  const canSubmitEmail = emailPassword.length > 0 && !isEmailSaving;

  async function handleEmailSubmit() {
    if (!canSubmitEmail) return;

    // Client-side: empty = remove, otherwise validate format
    const trimmedEmail = newEmail.trim();
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      addToast("error", t("emailInvalid"));
      return;
    }

    setIsEmailSaving(true);
    try {
      const res = await authApi.changeEmail(emailPassword, trimmedEmail);
      if (res.success) {
        const resultEmail = res.data?.email ?? null;
        updateUser({ email: resultEmail });
        addToast("success", trimmedEmail ? t("emailChanged") : t("emailRemoved"));
        setNewEmail("");
        setEmailPassword("");
      } else {
        const errMsg = res.error ?? "";
        if (errMsg.includes("incorrect") || errMsg.includes("unauthorized")) {
          addToast("error", t("wrongCurrentPassword"));
        } else if (errMsg.includes("already in use") || errMsg.includes("already exists")) {
          addToast("error", t("emailAlreadyExists"));
        } else if (errMsg.includes("invalid email")) {
          addToast("error", t("emailInvalid"));
        } else if (errMsg.includes("same as current")) {
          addToast("error", t("emailSameAsCurrent"));
        } else {
          addToast("error", t("emailChangeError"));
        }
      }
    } finally {
      setIsEmailSaving(false);
    }
  }

  // ─── Password Handlers ───
  const canSubmitPassword =
    currentPassword.length > 0 &&
    newPassword.length > 0 &&
    confirmPassword.length > 0 &&
    !isSaving;

  async function handlePasswordSubmit() {
    if (!canSubmitPassword) return;

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
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      } else {
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

      {/* ═══ Email Section ═══ */}
      <h3 className="settings-section-subtitle">{t("emailSection")}</h3>

      {/* Current email display */}
      <div className="settings-field">
        <label className="settings-label">{t("currentEmail")}</label>
        <p className="settings-value">
          {user?.email ?? t("noEmail")}
        </p>
      </div>

      {/* New email */}
      <div className="settings-field">
        <label htmlFor="newEmail" className="settings-label">
          {t("newEmail")}
        </label>
        <input
          id="newEmail"
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder={t("emailPlaceholder")}
          className="settings-input"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>

      {/* Password verification */}
      <div className="settings-field">
        <label htmlFor="emailPassword" className="settings-label">
          {t("currentPassword")}
        </label>
        <input
          id="emailPassword"
          type="password"
          value={emailPassword}
          onChange={(e) => setEmailPassword(e.target.value)}
          placeholder={t("emailPasswordPlaceholder")}
          className="settings-input"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
        <p className="settings-hint">{t("emailPasswordRequired")}</p>
      </div>

      {/* Email actions */}
      <div className="settings-btn-row">
        <button
          onClick={handleEmailSubmit}
          disabled={!canSubmitEmail || !newEmail.trim()}
          className="settings-btn"
        >
          {isEmailSaving ? t("changeEmail") + "..." : t("changeEmail")}
        </button>
        {user?.email && (
          <button
            onClick={() => {
              setNewEmail("");
              handleEmailSubmit();
            }}
            disabled={!canSubmitEmail}
            className="settings-btn settings-btn-danger"
          >
            {t("removeEmail")}
          </button>
        )}
      </div>

      {/* ═══ Separator ═══ */}
      <div className="settings-divider" />

      {/* ═══ Password Section ═══ */}
      <h3 className="settings-section-subtitle">{t("changePassword")}</h3>

      {/* Current Password */}
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
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>

      {/* New Password */}
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

      {/* Confirm New Password */}
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
          onClick={handlePasswordSubmit}
          disabled={!canSubmitPassword}
          className="settings-btn"
        >
          {isSaving ? t("changePassword") + "..." : t("changePassword")}
        </button>
      </div>
    </div>
  );
}

export default SecuritySettings;
