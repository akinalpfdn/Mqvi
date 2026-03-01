/**
 * SettingsNav — Settings modal'ın sol sidebar navigasyonu.
 *
 * CSS class'ları: .settings-nav, .settings-nav-label, .settings-nav-item,
 * .settings-nav-item.active
 *
 * Server Settings kategorisi sadece yetki sahibi kullanıcılara görünür.
 */

import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAuthStore } from "../../stores/authStore";
import { useMemberStore } from "../../stores/memberStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import { useIsMobile } from "../../hooks/useMediaQuery";
import type { SettingsTab } from "../../stores/settingsStore";

/** Tek bir navigation item tanımı */
type NavItem = {
  id: SettingsTab;
  labelKey: string;
};

/** User Settings kategorisi — herkese görünür */
const USER_ITEMS: NavItem[] = [
  { id: "profile", labelKey: "profile" },
  { id: "appearance", labelKey: "appearance" },
  { id: "voice", labelKey: "voiceSettings" },
  { id: "security", labelKey: "security" },
];

/** Server Settings kategorisi — permission-gated */
const SERVER_ITEMS: NavItem[] = [
  { id: "server-general", labelKey: "general" },
  { id: "channels", labelKey: "channels" },
  { id: "roles", labelKey: "roles" },
  { id: "members", labelKey: "members" },
  { id: "invites", labelKey: "invites" },
];

/** Platform Settings kategorisi — sadece platform admin'lere görünür */
const PLATFORM_ITEMS: NavItem[] = [
  { id: "platform", labelKey: "platformLiveKitInstances" },
  { id: "platform-servers", labelKey: "platformServersTab" },
  { id: "platform-users", labelKey: "platformUsersTab" },
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
          {PLATFORM_ITEMS.map((item) => (
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

      {/* Log Out — mobilde horizontal tab bar'ın sonuna eklenir */}
      {!isMobile && <div className="settings-nav-divider settings-nav-divider-push" />}
      <button
        className="settings-nav-item settings-nav-logout"
        onClick={logout}
      >
        {t("logOut")}
      </button>

      {/* App Version — sadece desktop */}
      {!isMobile && (
        <p className="settings-nav-version">mqvi v1.0.0</p>
      )}
    </nav>
  );
}

export default SettingsNav;
