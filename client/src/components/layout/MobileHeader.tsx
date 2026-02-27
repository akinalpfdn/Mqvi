/**
 * MobileHeader — Mobil üst bar (48px).
 *
 * Hamburger butonu (sidebar drawer) + aktif kanal/tab adı + member butonu.
 * Sadece mobil görünümde gösterilir (CSS: display:none → display:flex @768px).
 *
 * Aktif tab bilgisi uiStore'dan alınır — type'a göre hash/ikon gösterilir.
 *
 * CSS class'ları: .mobile-header, .mobile-header-btn, .mobile-header-title,
 * .mobile-header-hash
 */

import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { useMobileStore } from "../../stores/mobileStore";

function MobileHeader() {
  const { t } = useTranslation("common");

  const panels = useUIStore((s) => s.panels);
  const activePanelId = useUIStore((s) => s.activePanelId);

  const leftDrawerOpen = useMobileStore((s) => s.leftDrawerOpen);
  const rightDrawerOpen = useMobileStore((s) => s.rightDrawerOpen);
  const openLeftDrawer = useMobileStore((s) => s.openLeftDrawer);
  const closeLeftDrawer = useMobileStore((s) => s.closeLeftDrawer);
  const openRightDrawer = useMobileStore((s) => s.openRightDrawer);
  const closeRightDrawer = useMobileStore((s) => s.closeRightDrawer);

  // Aktif paneldeki aktif tab'ı bul
  const panel = activePanelId ? panels[activePanelId] : null;
  const activeTab = panel?.tabs.find((tab) => tab.id === panel.activeTabId);

  // Tab type'a göre ikon
  function getTabIcon(): string {
    if (!activeTab) return "#";
    switch (activeTab.type) {
      case "text": return "#";
      case "voice": return "\uD83D\uDD0A";
      case "screen": return "\uD83D\uDDA5";
      case "dm": return "@";
      case "friends": return "\uD83D\uDC65";
      case "p2p": return "\uD83D\uDCDE";
      default: return "#";
    }
  }

  return (
    <div className="mobile-header">
      {/* Hamburger — sidebar drawer toggle */}
      <button
        className="mobile-header-btn"
        onClick={leftDrawerOpen ? closeLeftDrawer : openLeftDrawer}
        title={t("openSidebar")}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {/* Aktif kanal/tab adı */}
      <div className="mobile-header-title">
        <span className="mobile-header-hash">{getTabIcon()}</span>
        <span>{activeTab?.label ?? t("channels")}</span>
      </div>

      {/* Members toggle — mobilde sağ drawer'ı açar/kapatır */}
      <button
        className="mobile-header-btn"
        onClick={rightDrawerOpen ? closeRightDrawer : openRightDrawer}
        title={rightDrawerOpen ? t("closeMembers") : t("openMembers")}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </button>
    </div>
  );
}

export default MobileHeader;
