/** LoginPage — User login page. i18n: "auth" namespace. */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { isElectron } from "../../utils/constants";

function LoginPage() {
  // ─── Hooks ───
  const { t } = useTranslation("auth");
  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Load saved credentials from Electron safeStorage on mount
  useEffect(() => {
    if (!isElectron()) return;
    window.electronAPI?.loadCredentials().then((cred) => {
      if (cred) {
        setUsername(cred.username);
        setPassword(cred.password);
        setRememberMe(true);
      }
    });
  }, []);

  // ─── Handlers ───
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const success = await login(username, password);
    if (success) {
      // Electron: save or clear credentials
      if (isElectron()) {
        if (rememberMe) {
          window.electronAPI?.saveCredentials(username, password);
        } else {
          window.electronAPI?.clearCredentials();
        }
      }
      // Redirect to returnUrl (e.g. invite link) or /channels
      const returnUrl = searchParams.get("returnUrl");
      navigate(returnUrl ?? "/channels");
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
            <div className="auth-field-password">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  handleInputChange();
                }}
                required
                className="auth-input"
              />
              <button
                type="button"
                className="auth-password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={t(showPassword ? "hidePassword" : "showPassword")}
              >
                {showPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Electron: Remember me checkbox */}
          {isElectron() && (
            <label className="auth-remember">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              />
              <span>{t("rememberMe")}</span>
            </label>
          )}

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
          <Link to={searchParams.get("returnUrl") ? `/register?returnUrl=${searchParams.get("returnUrl")}` : "/register"}>{t("registerLink")}</Link>
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
