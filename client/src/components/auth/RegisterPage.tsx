/**
 * RegisterPage — Kullanıcı kayıt sayfası.
 *
 * CSS class'ları: .auth-page, .auth-card, .auth-title,
 * .auth-error, .auth-field, .auth-label, .auth-input, .auth-btn, .auth-link
 *
 * i18n: "auth" namespace'ini kullanır.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";

function RegisterPage() {
  // ─── Hooks ───
  const { t } = useTranslation("auth");
  const register = useAuthStore((s) => s.register);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  // ─── Handlers ───
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);

    if (password !== confirmPassword) {
      setLocalError(t("passwordsDoNotMatch"));
      return;
    }

    if (password.length < 8) {
      setLocalError(t("passwordTooShort"));
      return;
    }

    const success = await register(
      username,
      password,
      displayName || undefined
    );
    if (success) {
      navigate("/channels");
    }
  }

  function handleInputChange() {
    if (error) clearError();
    if (localError) setLocalError(null);
  }

  const displayError = localError ?? error;

  // ─── Render ───
  return (
    <div className="auth-page">
      <div className="auth-card">
        {/* Header */}
        <h1 className="auth-title">{t("createAccount")}</h1>

        {/* Error Banner */}
        {displayError && <div className="auth-error">{displayError}</div>}

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="username" className="auth-label">
              {t("username")} <span style={{ color: "var(--red)" }}>*</span>
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                handleInputChange();
              }}
              required
              autoFocus
              minLength={3}
              maxLength={32}
              pattern="[a-zA-Z0-9_]+"
              title="Letters, numbers, and underscores only"
              className="auth-input"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="displayName" className="auth-label">
              {t("displayName")}
            </label>
            <input
              id="displayName"
              type="text"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                handleInputChange();
              }}
              maxLength={32}
              className="auth-input"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password" className="auth-label">
              {t("password")} <span style={{ color: "var(--red)" }}>*</span>
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                handleInputChange();
              }}
              required
              minLength={8}
              className="auth-input"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="confirmPassword" className="auth-label">
              {t("confirmPassword")} <span style={{ color: "var(--red)" }}>*</span>
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                handleInputChange();
              }}
              required
              className="auth-input"
            />
          </div>

          <button type="submit" disabled={isLoading} className="auth-btn">
            {isLoading ? t("registering") : t("register")}
          </button>
        </form>

        {/* Footer Link */}
        <p className="auth-link">
          {t("alreadyHaveAccount")}{" "}
          <Link to="/login">{t("loginLink")}</Link>
        </p>
      </div>
    </div>
  );
}

export default RegisterPage;
