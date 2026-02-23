/**
 * SidebarHeader — Sidebar üst kısmı: toggle butonu + arama.
 *
 * Expanded modda: mqvi logo/isim + collapse butonu + arama ikonu
 * Collapse butonu: sidebar'ı 52px'e daraltır
 * Arama ikonu: QuickSwitcher'ı tetikler (Ctrl+K)
 *
 * CSS class'ları: .sb-header, .sb-header-brand, .sb-header-actions
 */

import { useTranslation } from "react-i18next";
import { useSidebarStore } from "../../stores/sidebarStore";
import { useUIStore } from "../../stores/uiStore";

function SidebarHeader() {
  const { t } = useTranslation("common");
  const collapseSidebar = useSidebarStore((s) => s.collapseSidebar);
  const toggleQuickSwitcher = useUIStore((s) => s.toggleQuickSwitcher);

  return (
    <div className="sb-header">
      <div className="sb-header-brand">
        <img src="/mqvi-icon.svg" alt="mqvi" className="sb-logo" />
        <span className="sb-brand-name">{t("appName")}</span>
      </div>

      <div className="sb-header-actions">
        {/* Arama — QuickSwitcher'ı açar */}
        <button
          className="sb-header-btn"
          onClick={toggleQuickSwitcher}
          title={`${t("search")} (Ctrl+K)`}
        >
          &#x1F50D;
        </button>

        {/* Collapse — sidebar'ı daraltır */}
        <button
          className="sb-header-btn"
          onClick={collapseSidebar}
          title="Collapse"
        >
          &#x276E;
        </button>
      </div>
    </div>
  );
}

export default SidebarHeader;
