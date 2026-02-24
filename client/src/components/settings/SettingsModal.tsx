/**
 * SettingsModal — Discord tarzı tam ekran ayarlar overlay'i.
 *
 * CSS class'ları: .settings-overlay, .settings-content, .settings-close,
 * .settings-section-title
 *
 * Layout: Sol SettingsNav (218px) + sağ content area
 * Kapatma: ESC tuşu veya X butonu
 */

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
import ConnectionSettings from "./ConnectionSettings";

function SettingsModal() {
  const { t } = useTranslation("settings");
  const isOpen = useSettingsStore((s) => s.isOpen);
  const activeTab = useSettingsStore((s) => s.activeTab);
  const closeSettings = useSettingsStore((s) => s.closeSettings);

  // ESC tuşu ile kapatma
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
      {/* Sol navigasyon sidebar'ı */}
      <SettingsNav />

      {/* Sağ content area */}
      <div className="settings-content">
        <SettingsContent activeTab={activeTab} />
      </div>

      {/* Kapat butonu — sağ üst köşe */}
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

/**
 * SettingsContent — activeTab'a göre doğru component'i render eder.
 */
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

    case "members":
      return <MembersSettings />;

    case "connection":
      return <ConnectionSettings />;

    default:
      return null;
  }
}

export default SettingsModal;
