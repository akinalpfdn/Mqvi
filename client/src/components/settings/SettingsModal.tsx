/** Full-screen settings overlay. Layout: left SettingsNav + right content area. */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import SettingsNav from "./SettingsNav";
import RoleSettings from "./RoleSettings";
import ProfileSettings from "./ProfileSettings";
import AppearanceSettings from "./AppearanceSettings";
import ServerGeneralSettings from "./ServerGeneralSettings";
import InviteSettings from "./InviteSettings";
import VoiceSettings from "./VoiceSettings";
import ChannelSettings from "./ChannelSettings";
import MembersSettings from "./MembersSettings";
import SecuritySettings from "./SecuritySettings";
import PlatformSettings from "./PlatformSettings";
import AdminServerList from "./AdminServerList";
import AdminUserList from "./AdminUserList";
import AdminReportList from "./AdminReportList";
import ConnectionsSettings from "./ConnectionsSettings";
import EncryptionSettings from "./EncryptionSettings";
import GeneralSettings from "./GeneralSettings";

function SettingsModal() {
  const { t } = useTranslation("settings");
  const isOpen = useSettingsStore((s) => s.isOpen);
  const activeTab = useSettingsStore((s) => s.activeTab);
  const closeSettings = useSettingsStore((s) => s.closeSettings);

  // Close on ESC
  useEffect(() => {
    if (!isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        closeSettings();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeSettings]);

  // Body scroll lock
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="settings-overlay">
      {/* Nav sidebar */}
      <SettingsNav />

      {/* Content area */}
      <div className="settings-content">
        <SettingsContent activeTab={activeTab} />
      </div>

      {/* Close button */}
      <button
        onClick={closeSettings}
        className="settings-close"
        title={t("title") + " — ESC"}
      >
        ✕
      </button>
    </div>
  );
}

/** Renders the active tab's component. */
function SettingsContent({ activeTab }: { activeTab: string }) {
  switch (activeTab) {
    case "profile":
      return <ProfileSettings />;

    case "roles":
      return <RoleSettings />;

    case "server-general":
      return <ServerGeneralSettings />;

    case "invites":
      return <InviteSettings />;

    case "voice":
      return <VoiceSettings />;

    case "channels":
      return <ChannelSettings />;

    case "appearance":
      return <AppearanceSettings />;

    case "general":
      return <GeneralSettings />;

    case "members":
      return <MembersSettings />;

    case "security":
      return <SecuritySettings />;

    case "encryption":
      return <EncryptionSettings />;

    case "platform":
      return <PlatformSettings />;

    case "platform-servers":
      return <AdminServerList />;

    case "platform-users":
      return <AdminUserList />;

    case "platform-reports":
      return <AdminReportList />;

    case "platform-connections":
      return <ConnectionsSettings />;

    default:
      return null;
  }
}

export default SettingsModal;
