/** Settings sidebar navigation. Server Settings visible only to authorized users. */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import ConnectionsModal from "./ConnectionsModal";
import { useAuthStore } from "../../stores/authStore";
import { useActiveMembers } from "../../stores/memberStore";
import { useSettingsBadgeStore } from "../../stores/settingsBadgeStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { isElectron, isNativeApp } from "../../utils/constants";
import type { SettingsTab } from "../../stores/settingsStore";

/** Single nav item definition */
type NavItem = {
  id: SettingsTab;
  labelKey: string;
};

/** User Settings — visible to everyone */
const USER_ITEMS: NavItem[] = [
  { id: "profile", labelKey: "profile" },
  { id: "appearance", labelKey: "appearance" },
  { id: "voice", labelKey: "voiceSettings" },
  { id: "security", labelKey: "security" },
  { id: "encryption", labelKey: "encryption" },
  { id: "blocked-users", labelKey: "blockedUsers" },
  { id: "feedback", labelKey: "feedback" },
  { id: "help", labelKey: "help" },
  // "general" is added conditionally below (Electron only)
];

/** Server Settings — permission-gated */
const SERVER_ITEMS: NavItem[] = [
  { id: "server-general", labelKey: "general" },
  { id: "channels", labelKey: "channels" },
  { id: "roles", labelKey: "roles" },
  { id: "members", labelKey: "members" },
  { id: "invites", labelKey: "invites" },
];

/** Platform Settings — platform admin only */
const PLATFORM_ITEMS: NavItem[] = [
  { id: "platform", labelKey: "platformLiveKitInstances" },
  { id: "platform-servers", labelKey: "platformServersTab" },
  { id: "platform-users", labelKey: "platformUsersTab" },
  { id: "platform-reports", labelKey: "platformReportsTab" },
  { id: "platform-server-reports", labelKey: "platformServerReportsTab" },
  { id: "platform-feedback", labelKey: "platformFeedbackTab" },
  { id: "platform-logs", labelKey: "platformLogsTab" },
];

type SettingsNavProps = {
  /** Mobile: whether the slide-in drawer is open. */
  drawerOpen?: boolean;
  /** Mobile: called after a nav action so the parent can close the drawer. */
  onNavigate?: () => void;
};

function SettingsNav({ drawerOpen = false, onNavigate }: SettingsNavProps) {
  const { t } = useTranslation("settings");
  const activeTab = useSettingsStore((s) => s.activeTab);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const isMobile = useIsMobile();
  const [showConnections, setShowConnections] = useState(false);

  function handleSelect(tab: SettingsTab) {
    setActiveTab(tab);
    onNavigate?.();
  }

  const members = useActiveMembers();
  const currentMember = members.find((m) => m.id === user?.id);
  const perms = currentMember?.effective_permissions ?? 0;

  const isPlatformAdmin = user?.is_platform_admin ?? false;

  const hasNewFeedback = useSettingsBadgeStore((s) => s.hasNewFeedback);
  const hasNewReports = useSettingsBadgeStore((s) => s.hasNewReports);
  const hasNewMyFeedbackReply = useSettingsBadgeStore((s) => s.hasNewMyFeedbackReply);
  const refreshAdmin = useSettingsBadgeStore((s) => s.refreshAdmin);
  const refreshMyFeedback = useSettingsBadgeStore((s) => s.refreshMyFeedback);
  useEffect(() => {
    if (isPlatformAdmin) refreshAdmin();
    refreshMyFeedback();
  }, [isPlatformAdmin, refreshAdmin, refreshMyFeedback]);

  const canSeeServerSettings =
    hasPermission(perms, Permissions.Admin) ||
    hasPermission(perms, Permissions.ManageChannels) ||
    hasPermission(perms, Permissions.ManageRoles) ||
    hasPermission(perms, Permissions.KickMembers) ||
    hasPermission(perms, Permissions.BanMembers);

  // Join Requests is strictly gated: only ApproveMembers holders see it. A user with
  // ONLY this perm sees the Join Requests tab but not the other server-management tabs.
  const canApproveMembers = hasPermission(perms, Permissions.ApproveMembers);

  return (
    <>
    <nav className={`settings-nav${drawerOpen ? " open" : ""}`}>
      {/* User Settings */}
      <h3 className="settings-nav-label">{t("userSettings")}</h3>
      {USER_ITEMS.map((item) => {
        const showDot = item.id === "feedback" && hasNewMyFeedbackReply;
        return (
          <button
            key={item.id}
            className={`settings-nav-item${activeTab === item.id ? " active" : ""}`}
            onClick={() => handleSelect(item.id)}
          >
            <span className="settings-nav-item-label">{t(item.labelKey)}</span>
            {showDot && <span className="settings-nav-badge-dot" aria-hidden="true" />}
          </button>
        );
      })}
      {/* General (Desktop Settings) — Electron only */}
      {isElectron() && (
        <button
          className={`settings-nav-item${activeTab === "general" ? " active" : ""}`}
          onClick={() => handleSelect("general")}
        >
          {t("general")}
        </button>
      )}

      {/* Connections (self-host backend switch) — native apps: Electron + mobile.
          Opens a modal so it's reachable both here and from the login/register pages. */}
      {isNativeApp() && (
        <button
          className="settings-nav-item"
          onClick={() => { setShowConnections(true); onNavigate?.(); }}
        >
          {t("connections")}
        </button>
      )}

      {/* Server Settings (permission-gated) */}
      {(canSeeServerSettings || canApproveMembers) && (
        <>
          {!isMobile && <div className="settings-nav-divider" />}
          <h3 className="settings-nav-label">{t("serverSettings")}</h3>
          {canSeeServerSettings &&
            SERVER_ITEMS.map((item) => (
              <button
                key={item.id}
                className={`settings-nav-item${activeTab === item.id ? " active" : ""}`}
                onClick={() => handleSelect(item.id)}
              >
                {t(item.labelKey)}
              </button>
            ))}
          {canApproveMembers && (
            <button
              className={`settings-nav-item${activeTab === "join-requests" ? " active" : ""}`}
              onClick={() => handleSelect("join-requests")}
            >
              {t("joinRequests")}
            </button>
          )}
        </>
      )}

      {/* Platform Settings (platform admin only) */}
      {isPlatformAdmin && (
        <>
          {!isMobile && <div className="settings-nav-divider" />}
          <h3 className="settings-nav-label">{t("platformSettings")}</h3>
          {PLATFORM_ITEMS.map((item) => {
              const showDot =
                (item.id === "platform-reports" && hasNewReports) ||
                (item.id === "platform-feedback" && hasNewFeedback);
              return (
                <button
                  key={item.id}
                  className={`settings-nav-item${activeTab === item.id ? " active" : ""}`}
                  onClick={() => handleSelect(item.id)}
                >
                  <span className="settings-nav-item-label">{t(item.labelKey)}</span>
                  {showDot && <span className="settings-nav-badge-dot" aria-hidden="true" />}
                </button>
              );
            })}
        </>
      )}

      {/* Log Out */}
      {!isMobile && <div className="settings-nav-divider settings-nav-divider-push" />}
      <button
        className="settings-nav-item settings-nav-logout"
        onClick={logout}
      >
        {t("logOut")}
      </button>

      {/* App Version — desktop only */}
      {!isMobile && (
        <p className="settings-nav-version">mqvi v2.18.0</p>
      )}
    </nav>
    <ConnectionsModal isOpen={showConnections} onClose={() => setShowConnections(false)} />
    </>
  );
}

export default SettingsNav;
