/**
 * PanelTabBar — Panel-level tab çubuğu.
 *
 * CSS class'ları: .panel-tab-bar, .panel-tab, .panel-tab.active,
 * .panel-tab-close, .tab-icon (reuse TopBar'dan)
 *
 * Panelde birden fazla tab olduğunda gösterilir.
 * Tab'lar sürüklenebilir (drag) ve başka panellere bırakılabilir (drop).
 * TopBar tüm tab'ları gösterir, PanelTabBar sadece o paneldeki tab'ları gösterir.
 */

import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";

type PanelTabBarProps = {
  panelId: string;
};

function PanelTabBar({ panelId }: PanelTabBarProps) {
  const { t } = useTranslation("common");
  const panel = useUIStore((s) => s.panels[panelId]);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const closeTab = useUIStore((s) => s.closeTab);

  if (!panel) return null;

  return (
    <div className="panel-tab-bar">
      {panel.tabs.map((tab) => {
        const isActive = tab.id === panel.activeTabId;
        const isVoice = tab.type === "voice";
        const isScreen = tab.type === "screen";

        let tabClass = "panel-tab";
        if (isActive) tabClass += " active";
        if (isVoice) tabClass += " tab-voice";
        if (isScreen) tabClass += " tab-screen";

        return (
          <div
            key={tab.id}
            className={tabClass}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/tab-id", tab.id);
              e.dataTransfer.setData("text/panel-id", panelId);
              e.dataTransfer.effectAllowed = "move";
            }}
            onClick={() => setActiveTab(panelId, tab.id)}
          >
            {/* Icon */}
            <span className="tab-icon">
              {tab.type === "text" ? "#" : tab.type === "voice" ? "\uD83D\uDD0A" : "\uD83D\uDDA5"}
            </span>

            {/* Label */}
            <span className="tab-label">{tab.label}</span>

            {/* Close */}
            <button
              className="panel-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(panelId, tab.id);
              }}
              title={t("closeTab")}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default PanelTabBar;
