/**
 * SettingsModal — Discord tarzı tam ekran ayarlar overlay'i.
 *
 * Modal.tsx'ten farklıdır:
 * - Modal.tsx: küçük centered dialog (kanal oluşturma vb.)
 * - SettingsModal: tam ekran, sol nav + sağ content area
 *
 * Layout:
 * ┌────────────────────────────────────────────────┐
 * │  SettingsNav (218px)  │  Content Area          │
 * │  (sol sidebar)        │  (aktif tab component) │
 * │                       │                  [X]   │
 * └────────────────────────────────────────────────┘
 *
 * Kapatma yolları:
 * 1. ESC tuşu (keydown listener)
 * 2. Sağ üst X butonu
 *
 * Body scroll lock: Modal açıkken arka plandaki içerik scroll edilemez.
 */

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import SettingsNav from "./SettingsNav";
import RoleSettings from "./RoleSettings";
import ProfileSettings from "./ProfileSettings";
import ServerGeneralSettings from "./ServerGeneralSettings";

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

  // Body scroll lock — modal açıkken arka plan scroll edilemez
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
    <div className="fixed inset-0 z-50 flex bg-background">
      {/* Sol navigasyon sidebar'ı */}
      <SettingsNav />

      {/* Sağ content area */}
      <div className="relative flex flex-1 flex-col overflow-y-auto bg-background p-10">
        {/* Kapat butonu — sağ üst köşe */}
        <button
          onClick={closeSettings}
          className="absolute top-4 right-4 flex h-9 w-9 items-center justify-center rounded-full border border-background-tertiary text-text-muted transition-colors hover:border-text-secondary hover:text-text-primary"
          title={t("title") + " — ESC"}
        >
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>

        {/* Aktif tab content — tab'a göre doğru component render edilir */}
        <div className="mx-auto w-full max-w-2xl">
          <SettingsContent activeTab={activeTab} />
        </div>
      </div>
    </div>
  );
}

/**
 * SettingsContent — activeTab'a göre doğru component'i render eder.
 *
 * Henüz implement edilmemiş tab'lar "Coming soon" placeholder gösterir.
 * Yeni tab'lar eklendikçe buraya case eklenir.
 */
function SettingsContent({ activeTab }: { activeTab: string }) {
  const { t } = useTranslation("settings");

  switch (activeTab) {
    case "profile":
      return <ProfileSettings />;

    case "roles":
      return <RoleSettings />;

    case "server-general":
      return <ServerGeneralSettings />;

    // Placeholder tab'lar — gelecek fazlarda implement edilecek
    case "appearance":
    case "voice":
    case "members":
    case "invites":
      return (
        <div className="flex flex-col items-center justify-center py-20">
          <p className="text-lg font-semibold text-text-primary">
            {t(activeTab === "server-general" ? "general" : activeTab)}
          </p>
          <p className="mt-2 text-sm text-text-muted">{t("comingSoon")}</p>
        </div>
      );

    default:
      return null;
  }
}

export default SettingsModal;
