/** ActiveSessions — the account's signed-in devices, with remote sign-out. i18n: "settings" namespace. */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "../../stores/sessionStore";
import { useToastStore } from "../../stores/toastStore";
import { useConfirm } from "../../hooks/useConfirm";
import { formatFullDateTime } from "../../utils/dateFormat";
import type { DeviceSession } from "../../types";

const PLATFORM_KEYS: Record<NonNullable<DeviceSession["platform"]>, string> = {
  windows: "sessionPlatformWindows",
  macos: "sessionPlatformMacos",
  linux: "sessionPlatformLinux",
  android: "sessionPlatformAndroid",
  ios: "sessionPlatformIos",
  web: "sessionPlatformWeb",
};

const LABEL_KEYS: Record<string, string> = {
  desktop: "sessionLabelDesktop",
  mobile: "sessionLabelMobile",
};

function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function ActiveSessions() {
  const { t, i18n } = useTranslation("settings");
  const sessions = useSessionStore((s) => s.sessions);
  const isLoading = useSessionStore((s) => s.isLoading);
  const loadFailed = useSessionStore((s) => s.loadFailed);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const revokeSession = useSessionStore((s) => s.revokeSession);
  const revokeOtherSessions = useSessionStore((s) => s.revokeOtherSessions);
  const addToast = useToastStore((s) => s.addToast);
  const confirm = useConfirm();

  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  const hasOthers = sessions.some((s) => !s.is_current);

  function deviceName(session: DeviceSession): string {
    const platform = session.platform ? t(PLATFORM_KEYS[session.platform]) : t("sessionPlatformUnknown");
    const label = session.device_label;
    if (!label) return platform;
    return `${platform} · ${LABEL_KEYS[label] ? t(LABEL_KEYS[label]) : label}`;
  }

  function place(session: DeviceSession): string | null {
    const country = session.country ? countryName(session.country, i18n.language) : null;
    const parts = [session.city, country].filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : null;
  }

  async function handleRevoke(session: DeviceSession) {
    const ok = await confirm({
      message: t("sessionRevokeConfirm", { device: deviceName(session) }),
      confirmLabel: t("sessionRevoke"),
      danger: true,
    });
    if (!ok) return;
    if (await revokeSession(session.id)) {
      addToast("success", t("sessionRevoked"));
    } else {
      addToast("error", t("sessionRevokeFailed"));
    }
  }

  async function handleRevokeOthers() {
    const ok = await confirm({
      message: t("sessionRevokeOthersConfirm"),
      confirmLabel: t("sessionRevokeOthers"),
      danger: true,
    });
    if (!ok) return;
    if (await revokeOtherSessions()) {
      addToast("success", t("sessionRevokedOthers"));
    } else {
      addToast("error", t("sessionRevokeFailed"));
    }
  }

  return (
    <>
      <h3 className="settings-section-subtitle">{t("sessionsTitle")}</h3>
      <p className="settings-hint">{t("sessionsDescription")}</p>

      {loadFailed && <p className="settings-hint">{t("sessionsLoadFailed")}</p>}

      {isLoading && sessions.length === 0 ? (
        <p className="settings-value">…</p>
      ) : (
        <div className="session-list">
          {sessions.map((session) => {
            const where = place(session);
            return (
              <div key={session.id} className="session-item">
                <div className="session-info">
                  <span className="session-name">
                    {deviceName(session)}
                    {session.is_current && <span className="session-this"> ({t("sessionThisDevice")})</span>}
                  </span>
                  <span className="session-meta">
                    {[where, session.ip].filter(Boolean).join(" · ")}
                  </span>
                  <span className="session-meta">
                    {t("sessionLastActive", { time: formatFullDateTime(session.last_active, i18n.language) })}
                  </span>
                </div>
                {!session.is_current && (
                  <button
                    type="button"
                    onClick={() => void handleRevoke(session)}
                    className="settings-btn settings-btn-danger session-revoke"
                  >
                    {t("sessionRevoke")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {hasOthers && (
        <button
          type="button"
          onClick={() => void handleRevokeOthers()}
          className="settings-btn settings-btn-danger session-revoke-others"
        >
          {t("sessionRevokeOthers")}
        </button>
      )}

      <p className="session-attribution">
        <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
          {t("sessionGeoAttribution")}
        </a>
      </p>
    </>
  );
}

export default ActiveSessions;
