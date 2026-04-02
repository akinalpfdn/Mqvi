/** WelcomeModal — One-time modal after first login to introduce app features. */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { dismissWelcome } from "../../api/auth";

const FEATURES = [
  { key: "welcomeFeature1", icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM21 11l-3 3-2-2" },
  { key: "welcomeFeature2", icon: "M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM21 21l-4.35-4.35" },
  { key: "welcomeFeature3", icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" },
  { key: "welcomeFeature4", icon: "M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" },
] as const;

function WelcomeModal() {
  const { t } = useTranslation("auth");
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);
  const [dismissed, setDismissed] = useState(false);

  if (!user || user.has_seen_welcome || dismissed) {
    return null;
  }

  function handleDismiss() {
    setDismissed(true);
    updateUser({ has_seen_welcome: true });
    dismissWelcome();
  }

  return (
    <div className="welcome-overlay" onClick={handleDismiss}>
      <div className="welcome-modal" onClick={(e) => e.stopPropagation()}>
        <div className="welcome-logo">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <h3>{t("welcomeTitle")}</h3>
        <p>{t("welcomeDesc")}</p>
        <ul className="welcome-features">
          {FEATURES.map((f) => (
            <li key={f.key}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d={f.icon} />
              </svg>
              <span>{t(f.key)}</span>
            </li>
          ))}
        </ul>
        <button className="welcome-btn" onClick={handleDismiss}>
          {t("welcomeGotIt")}
        </button>
      </div>
    </div>
  );
}

export default WelcomeModal;
