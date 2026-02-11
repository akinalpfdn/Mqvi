/**
 * LoginPage — Kullanıcı giriş sayfası.
 *
 * React component yapısı (CLAUDE.md'deki sıraya uygun):
 * 1. Imports
 * 2. Types (varsa)
 * 3. Component (function declaration)
 * 4. Hooks
 * 5. Handlers
 * 6. Return JSX
 *
 * i18n: "auth" namespace'ini kullanır.
 * useTranslation("auth") → t("welcomeBack") gibi çeviri key'leri auth.json'dan çekilir.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";

function LoginPage() {
  // ─── Hooks ───
  // useTranslation("auth") — "auth" namespace'inden çeviri key'leri alır.
  // t("username") → auth.json'daki "username" key'inin o anki dildeki değeri.
  const { t } = useTranslation("auth");
  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);
  const navigate = useNavigate();

  // Component-local state — sadece form input'ları için.
  // Bu değerler başka component'leri ilgilendirmez, global store'a koymaya gerek yok.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // ─── Handlers ───
  async function handleSubmit(e: React.FormEvent) {
    // preventDefault: Formun sayfayı yenilemesini engeller.
    // HTML form'ları varsayılan olarak sayfa yeniler — SPA'da bunu istemeyiz.
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
    <div className="flex h-full items-center justify-center bg-background p-4">
      <div className="w-full max-w-[480px] rounded-md bg-surface px-8 py-10 shadow-lg">
        {/* ─── Header ─── */}
        <div className="mb-8 text-center">
          <h1 className="mb-2 text-[26px] font-bold leading-tight text-text-primary">
            {t("welcomeBack")}
          </h1>
          <p className="text-base text-text-secondary">
            {t("excitedToSeeYou")}
          </p>
        </div>

        {/* ─── Error Banner ─── */}
        {error && (
          <div className="mb-6 rounded-md bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger">
            {error}
          </div>
        )}

        {/* ─── Form ─── */}
        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label
              htmlFor="username"
              className="mb-2.5 block text-xs font-bold uppercase tracking-wide text-text-secondary"
            >
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
              className="h-11 w-full rounded-md bg-input px-3.5 text-base text-text-primary outline-none transition-colors focus:bg-input-focus"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-2.5 block text-xs font-bold uppercase tracking-wide text-text-secondary"
            >
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
              className="h-11 w-full rounded-md bg-input px-3.5 text-base text-text-primary outline-none transition-colors focus:bg-input-focus"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="mt-1 h-11 w-full rounded-md bg-brand text-base font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
          >
            {isLoading ? t("loggingIn") : t("login")}
          </button>
        </form>

        {/* ─── Footer Link ─── */}
        <p className="mt-6 text-sm text-text-muted">
          {t("needAccount")}{" "}
          <Link to="/register" className="text-text-link hover:underline">
            {t("registerLink")}
          </Link>
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
