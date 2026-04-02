/** RegisterPage — User registration page. i18n: "auth" namespace. */

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { isNativeApp } from "../../utils/constants";
import { detectOS, shouldShowDownloadPrompt } from "../../utils/detectOS";

/** Inline modal for Terms of Service / Privacy Policy */
function LegalModal({ type, onClose }: { type: "terms" | "privacy"; onClose: () => void }) {
  const { t } = useTranslation(type);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const sections: { title: string; content: string | string[] }[] = type === "terms" ? [
    { title: t("acceptanceTitle"), content: t("acceptanceDesc") },
    { title: t("serviceTitle"), content: t("serviceDesc") },
    { title: t("accountTitle"), content: t("accountDesc") },
    { title: t("contentTitle"), content: t("contentDesc") },
    { title: t("conductTitle"), content: [t("conductDesc"), t("conductItem1"), t("conductItem2"), t("conductItem3"), t("conductItem4"), t("conductItem5")] },
    { title: t("ipTitle"), content: t("ipDesc") },
    { title: t("disclaimerTitle"), content: t("disclaimerDesc") },
    { title: t("liabilityTitle"), content: t("liabilityDesc") },
    { title: t("indemnityTitle"), content: t("indemnityDesc") },
    { title: t("terminationTitle"), content: t("terminationDesc") },
    { title: t("copyrightTitle"), content: t("copyrightDesc") },
    { title: t("selfHostTitle"), content: t("selfHostDesc") },
    { title: t("voiceTitle"), content: t("voiceDesc") },
    { title: t("changesTitle"), content: t("changesDesc") },
    { title: t("lawTitle"), content: t("lawDesc") },
    { title: t("contactTitle"), content: t("contactDesc") },
  ] : [
    { title: t("introTitle"), content: t("introDesc") },
    { title: t("dataCollectedTitle"), content: [t("dataItem1"), t("dataItem2"), t("dataItem3"), t("dataItem4")] },
    { title: t("dataUsageTitle"), content: [t("dataUsageDesc"), t("usageItem1"), t("usageItem2"), t("usageItem3")] },
    { title: t("noTrackingTitle"), content: t("noTrackingDesc") },
    { title: t("dataSharingTitle"), content: t("dataSharingDesc") },
    { title: t("selfHostTitle"), content: t("selfHostDesc") },
    { title: t("deletionTitle"), content: t("deletionDesc") },
    { title: t("contactTitle"), content: t("contactDesc") },
  ];

  return (
    <div
      className="legal-modal-overlay"
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="legal-modal">
        <div className="legal-modal-header">
          <h2>{t("title")}</h2>
          <button className="legal-modal-close" onClick={onClose}>&#x2715;</button>
        </div>
        <div className="legal-modal-body">
          {sections.map((s, i) => (
            <div key={i} className="legal-modal-section">
              <h3>{s.title}</h3>
              {Array.isArray(s.content) ? (
                <>
                  <p>{s.content[0]}</p>
                  <ul>
                    {s.content.slice(1).map((item, j) => (
                      <li key={j}>{item}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>{s.content}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RegisterPage() {
  // ─── Hooks ───
  const { t } = useTranslation("auth");
  const register = useAuthStore((s) => s.register);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [legalModal, setLegalModal] = useState<"terms" | "privacy" | null>(null);

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
      displayName || undefined,
      email || undefined,
    );
    if (success) {
      // Redirect to returnUrl (e.g. invite link) or /channels
      const returnUrl = searchParams.get("returnUrl");
      navigate(returnUrl ?? "/channels");
    }
  }

  function handleInputChange() {
    if (error) clearError();
    if (localError) setLocalError(null);
  }

  const displayError = localError ?? error;

  // ─── Password toggle icon ───
  const EyeIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );

  const EyeOffIcon = (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    </svg>
  );

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
            <label htmlFor="email" className="auth-label">
              {t("emailOptional")}
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                handleInputChange();
              }}
              placeholder={t("emailPlaceholder")}
              className="auth-input"
            />
            {/* Warn if no email — password reset won't work */}
            {!email.trim() && (
              <p className="auth-email-warning">{t("emailWarning")}</p>
            )}
          </div>

          <div className="auth-field">
            <label htmlFor="password" className="auth-label">
              {t("password")} <span style={{ color: "var(--red)" }}>*</span>
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
                minLength={8}
                className="auth-input"
              />
              <button
                type="button"
                className="auth-password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={t(showPassword ? "hidePassword" : "showPassword")}
              >
                {showPassword ? EyeOffIcon : EyeIcon}
              </button>
            </div>
          </div>

          <div className="auth-field">
            <label htmlFor="confirmPassword" className="auth-label">
              {t("confirmPassword")} <span style={{ color: "var(--red)" }}>*</span>
            </label>
            <div className="auth-field-password">
              <input
                id="confirmPassword"
                type={showConfirmPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  handleInputChange();
                }}
                required
                className="auth-input"
              />
              <button
                type="button"
                className="auth-password-toggle"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                aria-label={t(showConfirmPassword ? "hidePassword" : "showPassword")}
              >
                {showConfirmPassword ? EyeOffIcon : EyeIcon}
              </button>
            </div>
          </div>

          <label className="auth-terms-check">
            <input
              type="checkbox"
              checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
            />
            <span>
              {t("agreeToTermsPre")}
              <button type="button" className="auth-terms-link" onClick={() => setLegalModal("terms")}>{t("termsLink")}</button>
              {t("agreeToTermsMid")}
              <button type="button" className="auth-terms-link" onClick={() => setLegalModal("privacy")}>{t("privacyLink")}</button>
              {t("agreeToTermsPost")}
            </span>
          </label>

          <button type="submit" disabled={isLoading || !acceptedTerms} className="auth-btn">
            {isLoading ? t("registering") : t("register")}
          </button>
        </form>

        {/* Legal document modal */}
        {legalModal && (
          <LegalModal type={legalModal} onClose={() => setLegalModal(null)} />
        )}

        {/* Footer Link */}
        <p className="auth-link">
          {t("alreadyHaveAccount")}{" "}
          <Link to={searchParams.get("returnUrl") ? `/login?returnUrl=${searchParams.get("returnUrl")}` : "/login"}>{t("loginLink")}</Link>
        </p>

        {shouldShowDownloadPrompt() && (() => {
          const { url, i18nKey } = detectOS();
          return (
            <a href={url} className="auth-download-link" target="_blank" rel="noopener noreferrer">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {t(i18nKey)}
            </a>
          );
        })()}

        {!isNativeApp() && (
          <Link to="/" className="auth-home-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {t("backToHome")}
          </Link>
        )}
      </div>
    </div>
  );
}

export default RegisterPage;
