/**
 * RegisterPage — Kullanıcı kayıt sayfası.
 *
 * i18n: "auth" namespace'ini kullanır.
 * Client-side validation mesajları da t() ile çevrilir.
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
    <div className="flex h-full items-center justify-center bg-background p-4">
      <div className="w-full max-w-[480px] rounded-md bg-surface px-8 py-10 shadow-lg">
        {/* ─── Header ─── */}
        <div className="mb-8 text-center">
          <h1 className="text-[26px] font-bold leading-tight text-text-primary">
            {t("createAccount")}
          </h1>
        </div>

        {/* ─── Error Banner ─── */}
        {displayError && (
          <div className="mb-6 rounded-md bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger">
            {displayError}
          </div>
        )}

        {/* ─── Form ─── */}
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label
              htmlFor="username"
              className="mb-2.5 block text-xs font-bold uppercase tracking-wide text-text-secondary"
            >
              {t("username")} <span className="text-danger">*</span>
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
              className="h-11 w-full rounded-md bg-input px-3.5 text-base text-text-primary outline-none transition-colors focus:bg-input-focus"
            />
          </div>

          <div>
            <label
              htmlFor="displayName"
              className="mb-2.5 block text-xs font-bold uppercase tracking-wide text-text-secondary"
            >
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
              className="h-11 w-full rounded-md bg-input px-3.5 text-base text-text-primary outline-none transition-colors focus:bg-input-focus"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-2.5 block text-xs font-bold uppercase tracking-wide text-text-secondary"
            >
              {t("password")} <span className="text-danger">*</span>
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
              className="h-11 w-full rounded-md bg-input px-3.5 text-base text-text-primary outline-none transition-colors focus:bg-input-focus"
            />
          </div>

          <div>
            <label
              htmlFor="confirmPassword"
              className="mb-2.5 block text-xs font-bold uppercase tracking-wide text-text-secondary"
            >
              {t("confirmPassword")} <span className="text-danger">*</span>
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
              className="h-11 w-full rounded-md bg-input px-3.5 text-base text-text-primary outline-none transition-colors focus:bg-input-focus"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="mt-1 h-11 w-full rounded-md bg-brand text-base font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
          >
            {isLoading ? t("registering") : t("register")}
          </button>
        </form>

        {/* ─── Footer Link ─── */}
        <p className="mt-6 text-sm text-text-muted">
          {t("alreadyHaveAccount")}{" "}
          <Link to="/login" className="text-text-link hover:underline">
            {t("loginLink")}
          </Link>
        </p>
      </div>
    </div>
  );
}

export default RegisterPage;
