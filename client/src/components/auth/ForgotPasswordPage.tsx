/**
 * ForgotPasswordPage — Request password reset email.
 * 90s cooldown between requests. States: form | sent | cooldown.
 * i18n: "auth" namespace.
 */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import * as authApi from "../../api/auth";

function ForgotPasswordPage() {
  // ─── Hooks ───
  const { t } = useTranslation("auth");

  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isSent, setIsSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cooldown countdown timer
  useEffect(() => {
    if (cooldown <= 0) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    timerRef.current = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [cooldown]);

  // ─── Handlers ───
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    const res = await authApi.forgotPassword(email);
    setIsLoading(false);

    if (res.error) {
      setError(res.error);
      return;
    }

    if (res.data?.cooldown && res.data.cooldown > 0) {
      setCooldown(res.data.cooldown);
      return;
    }

    setIsSent(true);
  }

  // ─── Render: Success ───
  if (isSent) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1 className="auth-title">{t("resetLinkSent")}</h1>
          <p className="auth-subtitle">{t("resetLinkSentSubtitle")}</p>
          <p className="auth-link">
            <Link to="/login">{t("backToLogin")}</Link>
          </p>
        </div>
      </div>
    );
  }

  // ─── Render: Form ───
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">{t("forgotPasswordTitle")}</h1>
        <p className="auth-subtitle">{t("forgotPasswordSubtitle")}</p>

        {error && <div className="auth-error">{error}</div>}

        {cooldown > 0 && (
          <div className="auth-error" style={{ borderColor: "var(--yellow)", color: "var(--yellow)", background: "var(--yellow-s, transparent)" }}>
            {t("cooldownMessage", { seconds: cooldown })}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="email" className="auth-label">
              {t("email")}
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error) setError("");
              }}
              placeholder={t("emailPlaceholder")}
              required
              autoFocus
              className="auth-input"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading || cooldown > 0}
            className="auth-btn"
          >
            {isLoading ? t("sending") : t("sendResetLink")}
          </button>
        </form>

        <p className="auth-link">
          <Link to="/login">{t("backToLogin")}</Link>
        </p>
      </div>
    </div>
  );
}

export default ForgotPasswordPage;
