/**
 * ResetPasswordPage — Yeni şifre belirleme sayfası.
 *
 * Email'deki reset link'inden açılır (/reset-password?token=xxx).
 * URL'den token okunur, kullanıcı yeni şifre belirler.
 *
 * Üç durum:
 * 1. form — yeni şifre + şifre tekrar input'ları
 * 2. success — şifre başarıyla sıfırlandı, login'e yönlendir
 * 3. error — geçersiz/expired token
 *
 * CSS class'ları: .auth-page, .auth-card, .auth-title, .auth-subtitle,
 * .auth-error, .auth-field, .auth-label, .auth-input, .auth-btn, .auth-link
 *
 * i18n: "auth" namespace'ini kullanır.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import * as authApi from "../../api/auth";

function ResetPasswordPage() {
  // ─── Hooks ───
  const { t } = useTranslation("auth");
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isSuccess, setIsSuccess] = useState(false);

  // ─── Handlers ───
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (newPassword !== confirmPassword) {
      setError(t("passwordsDoNotMatch"));
      return;
    }

    if (newPassword.length < 8) {
      setError(t("passwordTooShort"));
      return;
    }

    setIsLoading(true);
    const res = await authApi.resetPassword(token, newPassword);
    setIsLoading(false);

    if (res.error) {
      setError(res.error);
      return;
    }

    setIsSuccess(true);
  }

  // ─── Render: No Token ───
  if (!token) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1 className="auth-title">{t("resetPasswordTitle")}</h1>
          <div className="auth-error">{t("invalidOrExpiredToken")}</div>
          <p className="auth-link">
            <Link to="/login">{t("goToLogin")}</Link>
          </p>
        </div>
      </div>
    );
  }

  // ─── Render: Success ───
  if (isSuccess) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1 className="auth-title">{t("resetSuccess")}</h1>
          <p className="auth-subtitle">{t("resetSuccessSubtitle")}</p>
          <Link to="/login" className="auth-btn" style={{ display: "block", textAlign: "center", textDecoration: "none", lineHeight: "44px" }}>
            {t("goToLogin")}
          </Link>
        </div>
      </div>
    );
  }

  // ─── Render: Form ───
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">{t("resetPasswordTitle")}</h1>
        <p className="auth-subtitle">{t("resetPasswordSubtitle")}</p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="new-password" className="auth-label">
              {t("newPassword")}
            </label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => {
                setNewPassword(e.target.value);
                if (error) setError("");
              }}
              required
              autoFocus
              className="auth-input"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="confirm-password" className="auth-label">
              {t("confirmNewPassword")}
            </label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                if (error) setError("");
              }}
              required
              className="auth-input"
            />
          </div>

          <button type="submit" disabled={isLoading} className="auth-btn">
            {isLoading ? t("resetting") : t("resetPassword")}
          </button>
        </form>

        <p className="auth-link">
          <Link to="/login">{t("backToLogin")}</Link>
        </p>
      </div>
    </div>
  );
}

export default ResetPasswordPage;
