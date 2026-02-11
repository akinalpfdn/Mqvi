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
    <div className="flex h-full items-center justify-center bg-background">
      <div className="w-full max-w-md rounded-lg bg-surface p-8">
        <div className="mb-6 text-center">
          <h1 className="mb-2 text-2xl font-bold text-text-primary">
            {t("welcomeBack")}
          </h1>
          <p className="text-text-secondary">
            {t("excitedToSeeYou")}
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="username"
              className="mb-2 block text-xs font-bold uppercase text-text-secondary"
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
              className="w-full rounded bg-input p-2.5 text-text-primary outline-none transition-colors focus:bg-input-focus"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-2 block text-xs font-bold uppercase text-text-secondary"
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
              className="w-full rounded bg-input p-2.5 text-text-primary outline-none transition-colors focus:bg-input-focus"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full rounded bg-brand p-2.5 font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
          >
            {isLoading ? t("loggingIn") : t("login")}
          </button>
        </form>

        <p className="mt-4 text-sm text-text-muted">
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
