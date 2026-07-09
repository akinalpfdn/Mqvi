/** Full-screen settings overlay. Layout: left SettingsNav + right content area. */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { useIsMobile } from "../../hooks/useMediaQuery";
import SettingsNav from "./SettingsNav";
import RoleSettings from "./RoleSettings";
import ProfileSettings from "./ProfileSettings";
import AppearanceSettings from "./AppearanceSettings";
import ServerGeneralSettings from "./ServerGeneralSettings";
import InviteSettings from "./InviteSettings";
import VoiceSettings from "./VoiceSettings";
import ChannelSettings from "./ChannelSettings";
import MembersSettings from "./MembersSettings";
import JoinRequestsSettings from "./JoinRequestsSettings";
import SecuritySettings from "./SecuritySettings";
import PlatformSettings from "./PlatformSettings";
import AdminServerList from "./AdminServerList";
import AdminUserList from "./AdminUserList";
import AdminReportList from "./AdminReportList";
import AdminLogsPanel from "./AdminLogsPanel";
import EncryptionSettings from "./EncryptionSettings";
import GeneralSettings from "./GeneralSettings";
import FeedbackSettings from "./FeedbackSettings";
import BlockedUsersSettings from "./BlockedUsersSettings";
import AdminFeedbackList from "./AdminFeedbackList";
import HelpCenter from "../shared/HelpCenter";

function SettingsModal() {
  const { t } = useTranslation("settings");
  const isOpen = useSettingsStore((s) => s.isOpen);
  const activeTab = useSettingsStore((s) => s.activeTab);
  const closeSettings = useSettingsStore((s) => s.closeSettings);
  const isMobile = useIsMobile();
  const [navOpen, setNavOpen] = useState(false);

  // Reset the mobile nav drawer whenever settings closes.
  useEffect(() => {
    if (!isOpen) setNavOpen(false);
  }, [isOpen]);

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

  function handleOverlayClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) {
      closeSettings();
    }
  }

  return (
    <div className="settings-overlay" onClick={handleOverlayClick}>
      {/* Mobile: dim backdrop behind the nav drawer */}
      {isMobile && navOpen && (
        <div className="settings-nav-backdrop" onClick={() => setNavOpen(false)} />
      )}

      {/* Nav — fixed sidebar on desktop, slide-in drawer on mobile */}
      <SettingsNav drawerOpen={navOpen} onNavigate={() => setNavOpen(false)} />

      {/* Content area — close button anchored to the panel's top-right corner */}
      <div className="settings-panel">
        {isMobile && (
          <button
            className="settings-nav-toggle"
            onClick={() => setNavOpen(true)}
            aria-label={t("title")}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        )}
        <button
          onClick={closeSettings}
          className="settings-close"
          title={t("title") + " — ESC"}
        >
          ✕
        </button>
        <div className="settings-content">
          <SettingsContent activeTab={activeTab} />
        </div>
      </div>
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

    case "join-requests":
      return <JoinRequestsSettings />;

    case "security":
      return <SecuritySettings />;

    case "encryption":
      return <EncryptionSettings />;

    case "feedback":
      return <FeedbackSettings />;

    case "blocked-users":
      return <BlockedUsersSettings />;

    case "help":
      return (
        <div className="settings-section settings-help">
          <HelpCenter view="tabs" />
        </div>
      );

    case "platform":
      return <PlatformSettings />;

    case "platform-servers":
      return <AdminServerList />;

    case "platform-users":
      return <AdminUserList />;

    case "platform-reports":
      return <AdminReportList />;

    case "platform-logs":
      return <AdminLogsPanel />;

    case "platform-feedback":
      return <AdminFeedbackList />;

    default:
      return null;
  }
}

export default SettingsModal;
