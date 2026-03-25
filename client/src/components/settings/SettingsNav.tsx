/** Settings sidebar navigation. Server Settings visible only to authorized users. */

import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAuthStore } from "../../stores/authStore";
import { useMemberStore } from "../../stores/memberStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { isElectron } from "../../utils/constants";
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
  { id: "platform-logs", labelKey: "platformLogsTab" },
  { id: "platform-connections", labelKey: "platformConnections" },
];

function SettingsNav() {
  const { t } = useTranslation("settings");
  const activeTab = useSettingsStore((s) => s.activeTab);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const isMobile = useIsMobile();

  const members = useMemberStore((s) => s.members);
  const currentMember = members.find((m) => m.id === user?.id);
  const perms = currentMember?.effective_permissions ?? 0;

  const isPlatformAdmin = user?.is_platform_admin ?? false;

  const canSeeServerSettings =
    hasPermission(perms, Permissions.Admin) ||
    hasPermission(perms, Permissions.ManageChannels) ||
    hasPermission(perms, Permissions.ManageRoles) ||
    hasPermission(perms, Permissions.KickMembers) ||
    hasPermission(perms, Permissions.BanMembers);

  return (
    <nav className="settings-nav">
      {/* User Settings */}
      <h3 className="settings-nav-label">{t("userSettings")}</h3>
      {USER_ITEMS.map((item) => (
        <button
          key={item.id}
          className={`settings-nav-item${activeTab === item.id ? " active" : ""}`}
          onClick={() => setActiveTab(item.id)}
        >
          {t(item.labelKey)}
        </button>
      ))}
      {/* General (Desktop Settings) — Electron only */}
      {isElectron() && (
        <button
          className={`settings-nav-item${activeTab === "general" ? " active" : ""}`}
          onClick={() => setActiveTab("general")}
        >
          {t("general")}
        </button>
      )}

      {/* Server Settings (permission-gated) */}
      {canSeeServerSettings && (
        <>
          {!isMobile && <div className="settings-nav-divider" />}
          <h3 className="settings-nav-label">{t("serverSettings")}</h3>
          {SERVER_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`settings-nav-item${activeTab === item.id ? " active" : ""}`}
              onClick={() => setActiveTab(item.id)}
            >
              {t(item.labelKey)}
            </button>
          ))}
        </>
      )}

      {/* Platform Settings (platform admin only) */}
      {isPlatformAdmin && (
        <>
          {!isMobile && <div className="settings-nav-divider" />}
          <h3 className="settings-nav-label">{t("platformSettings")}</h3>
          {PLATFORM_ITEMS
            .filter((item) => item.id !== "platform-connections" || isElectron())
            .map((item) => (
              <button
                key={item.id}
                className={`settings-nav-item${activeTab === item.id ? " active" : ""}`}
                onClick={() => setActiveTab(item.id)}
              >
                {t(item.labelKey)}
              </button>
            ))}
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
        <p className="settings-nav-version">mqvi v2.6.0</p>
      )}
    </nav>
  );
}

export default SettingsNav;
