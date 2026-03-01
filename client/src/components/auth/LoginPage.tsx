/**
 * LoginPage — Kullanıcı giriş sayfası.
 *
 * CSS class'ları: .auth-page, .auth-card, .auth-title, .auth-subtitle,
 * .auth-error, .auth-field, .auth-label, .auth-input, .auth-btn, .auth-link
 *
 * i18n: "auth" namespace'ini kullanır.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";

function LoginPage() {
  // ─── Hooks ───
  const { t } = useTranslation("auth");
  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // ─── Handlers ───
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const success = await login(username, password);
    if (success) {
      navigate("/channels");
    }
  }

  function handleInputChange() {
    if (error) clearError();
  }

  // ─── Render ───
  return (
    <div className="auth-page">
      <div className="auth-card">
        {/* Header */}
        <h1 className="auth-title">{t("welcomeBack")}</h1>
        <p className="auth-subtitle">{t("excitedToSeeYou")}</p>

        {/* Error Banner */}
        {error && <div className="auth-error">{error}</div>}

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="username" className="auth-label">
              {t("username")}
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
              className="auth-input"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password" className="auth-label">
              {t("password")}
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
              className="auth-input"
            />
          </div>

          <button type="submit" disabled={isLoading} className="auth-btn">
            {isLoading ? t("loggingIn") : t("login")}
          </button>
        </form>

        {/* Forgot Password Link */}
        <p className="auth-link" style={{ marginTop: "12px" }}>
          <Link to="/forgot-password">{t("forgotPassword")}</Link>
        </p>

        {/* Footer Link */}
        <p className="auth-link">
          {t("needAccount")}{" "}
          <Link to="/register">{t("registerLink")}</Link>
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
