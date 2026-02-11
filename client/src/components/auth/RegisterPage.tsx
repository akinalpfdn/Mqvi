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
    <div className="flex h-full items-center justify-center bg-background">
      <div className="w-full max-w-md rounded-lg bg-surface p-8">
        <div className="mb-6 text-center">
          <h1 className="mb-2 text-2xl font-bold text-text-primary">
            {t("createAccount")}
          </h1>
        </div>

        {displayError && (
          <div className="mb-4 rounded bg-danger/10 p-3 text-sm text-danger">
            {displayError}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="username"
              className="mb-2 block text-xs font-bold uppercase text-text-secondary"
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
              className="w-full rounded bg-input p-2.5 text-text-primary outline-none transition-colors focus:bg-input-focus"
            />
          </div>

          <div>
            <label
              htmlFor="displayName"
              className="mb-2 block text-xs font-bold uppercase text-text-secondary"
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
              className="w-full rounded bg-input p-2.5 text-text-primary outline-none transition-colors focus:bg-input-focus"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-2 block text-xs font-bold uppercase text-text-secondary"
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
              className="w-full rounded bg-input p-2.5 text-text-primary outline-none transition-colors focus:bg-input-focus"
            />
          </div>

          <div>
            <label
              htmlFor="confirmPassword"
              className="mb-2 block text-xs font-bold uppercase text-text-secondary"
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
              className="w-full rounded bg-input p-2.5 text-text-primary outline-none transition-colors focus:bg-input-focus"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded bg-brand p-2.5 font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
          >
            {isLoading ? t("registering") : t("register")}
          </button>
        </form>

        <p className="mt-4 text-sm text-text-muted">
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
