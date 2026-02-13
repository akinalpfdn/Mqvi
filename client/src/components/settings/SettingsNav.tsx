/**
 * SettingsNav — Settings modal'ın sol sidebar navigasyonu.
 *
 * Yapı:
 * - "User Settings" kategorisi: Profile, Appearance*, Voice & Video*
 * - "Server Settings" kategorisi: General, Roles, Members*, Invites*
 * - Separator + Log Out butonu
 *
 * * = Placeholder (gelecek fazlarda implement edilecek)
 *
 * Server Settings kategorisi sadece yetki sahibi kullanıcılara görünür.
 * Permission kontrolü client-side yapılır (effective_permissions),
 * backend zaten API çağrılarında enforce eder.
 */

import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useAuthStore } from "../../stores/authStore";
import { useMemberStore } from "../../stores/memberStore";
import { hasPermission, Permissions } from "../../utils/permissions";
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
];

/** Server Settings kategorisi — permission-gated */
const SERVER_ITEMS: NavItem[] = [
  { id: "server-general", labelKey: "general" },
  { id: "roles", labelKey: "roles" },
  { id: "members", labelKey: "members" },
  { id: "invites", labelKey: "invites" },
];

function SettingsNav() {
  const { t } = useTranslation("settings");
  const { t: tAuth } = useTranslation("auth");
  const activeTab = useSettingsStore((s) => s.activeTab);
  const setActiveTab = useSettingsStore((s) => s.setActiveTab);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);

  // Kendi effective_permissions'ımızı memberStore'dan al
  const members = useMemberStore((s) => s.members);
  const currentMember = members.find((m) => m.id === user?.id);
  const perms = currentMember?.effective_permissions ?? 0;

  // Server Settings'e erişim: Admin, ManageChannels, ManageRoles, KickMembers veya BanMembers
  const canSeeServerSettings =
    hasPermission(perms, Permissions.Admin) ||
    hasPermission(perms, Permissions.ManageChannels) ||
    hasPermission(perms, Permissions.ManageRoles) ||
    hasPermission(perms, Permissions.KickMembers) ||
    hasPermission(perms, Permissions.BanMembers);

  return (
    <nav className="flex w-settings-nav shrink-0 flex-col bg-background-secondary py-6 pr-2 pl-5">
      {/* ─── User Settings ─── */}
      <CategoryLabel text={t("userSettings")} />
      {USER_ITEMS.map((item) => (
        <NavButton
          key={item.id}
          label={t(item.labelKey)}
          isActive={activeTab === item.id}
          onClick={() => setActiveTab(item.id)}
        />
      ))}

      {/* ─── Server Settings (permission-gated) ─── */}
      {canSeeServerSettings && (
        <>
          <div className="my-2 border-t border-background-tertiary" />
          <CategoryLabel text={t("serverSettings")} />
          {SERVER_ITEMS.map((item) => (
            <NavButton
              key={item.id}
              label={t(item.labelKey)}
              isActive={activeTab === item.id}
              onClick={() => setActiveTab(item.id)}
            />
          ))}
        </>
      )}

      {/* ─── Log Out ─── */}
      <div className="mt-auto border-t border-background-tertiary pt-2">
        <NavButton
          label={t("logOut")}
          isActive={false}
          onClick={logout}
          isDanger
        />
      </div>

      {/* ─── App Version ─── */}
      <p className="mt-2 px-2.5 text-[11px] text-text-muted">
        mqvi v0.1.0
      </p>
    </nav>
  );
}

/** Kategori başlığı — uppercase, küçük font */
function CategoryLabel({ text }: { text: string }) {
  return (
    <h3 className="mb-1 px-2.5 pt-4 pb-1 text-[11px] font-bold uppercase tracking-wide text-text-muted">
      {text}
    </h3>
  );
}

/** Tek bir navigasyon butonu */
function NavButton({
  label,
  isActive,
  onClick,
  isDanger = false,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
  isDanger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full rounded px-2.5 py-1.5 text-left text-sm font-medium transition-colors ${
        isActive
          ? "bg-surface-active text-text-primary"
          : isDanger
            ? "text-danger hover:bg-surface-hover hover:text-danger"
            : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
      }`}
    >
      {label}
    </button>
  );
}

export default SettingsNav;
