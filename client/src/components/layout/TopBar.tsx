/**
 * TopBar — Üst bar: server pill + tab strip.
 *
 * CSS class'ları: .top-bar, .server-pill, .sp-avatar, .sp-name,
 * .sp-chevron, .tab-strip, .tab, .tab-active, .tab-voice, .tab-screen,
 * .tab-icon, .tab-label, .tab-srv, .tab-dot, .tab-close
 *
 * Tab active indicator (amber alt çizgi) CSS'te .tab-active::after ile oluşturulur.
 * Voice tab'lar yeşil, screen tab'lar kırmızı çizgi alır.
 */

import { useTranslation } from "react-i18next";
import { useServerStore } from "../../stores/serverStore";
import { useUIStore } from "../../stores/uiStore";
import type { Tab, Panel } from "../../stores/uiStore";
import { publicAsset } from "../../utils/constants";

/**
 * Tüm panellerdeki tab'ları birleştirip flat bir liste döner.
 * Her tab'a ait panelId bilgisi de eklenir.
 */
function flattenTabs(panels: Record<string, Panel>): Array<Tab & { panelId: string; isActive: boolean }> {
  const result: Array<Tab & { panelId: string; isActive: boolean }> = [];
  for (const panel of Object.values(panels)) {
    for (const tab of panel.tabs) {
      result.push({
        ...tab,
        panelId: panel.id,
        isActive: tab.id === panel.activeTabId,
      });
    }
  }
  return result;
}

function TopBar() {
  const { t } = useTranslation("common");
  const server = useServerStore((s) => s.server);
  const panels = useUIStore((s) => s.panels);
  const activePanelId = useUIStore((s) => s.activePanelId);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const closeTab = useUIStore((s) => s.closeTab);

  const allTabs = flattenTabs(panels);

  /** Drag start — tab id'yi dataTransfer'e ekle */
  function handleDragStart(e: React.DragEvent, tab: Tab & { panelId: string }) {
    e.dataTransfer.setData("text/tab-id", tab.id);
    e.dataTransfer.setData("text/panel-id", tab.panelId);
    e.dataTransfer.effectAllowed = "move";
  }

  return (
    <div className="top-bar">
      {/* ─── Server Pill ─── */}
      <div className="server-pill">
        <img src={publicAsset("mqvi-icon.svg")} alt="mqvi" className="sp-avatar" />
        <span className="sp-name">
          {server?.name ?? "mqvi Server"}
        </span>
        <span className="sp-chevron">▾</span>
      </div>

      {/* ─── Tab Strip ─── */}
      <div className="tab-strip">
        {allTabs.map((tab) => {
          const isActiveInActivePanel = tab.panelId === activePanelId && tab.isActive;
          const isVoice = tab.type === "voice";
          const isScreen = tab.type === "screen";

          let tabClass = "tab";
          if (isActiveInActivePanel) tabClass += " tab-active";
          if (isVoice) tabClass += " tab-voice";
          if (isScreen) tabClass += " tab-screen";

          return (
            <div
              key={tab.id}
              className={tabClass}
              style={{ maxWidth: 170 }}
              draggable
              onDragStart={(e) => handleDragStart(e, tab)}
              onClick={() => setActiveTab(tab.panelId, tab.id)}
            >
              {/* Tab icon */}
              <span className="tab-icon">
                {tab.type === "text" ? "#" : tab.type === "voice" ? "\uD83D\uDD0A" : "\uD83D\uDDA5"}
              </span>

              {/* Tab label */}
              <span className="tab-label">{tab.label}</span>

              {/* Server etiketi */}
              {tab.serverShort && (
                <span className="tab-srv">{tab.serverShort}</span>
              )}

              {/* Unread dot */}
              {tab.hasUnread && !isActiveInActivePanel && (
                <span className="tab-dot" />
              )}

              {/* Close button */}
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.panelId, tab.id);
                }}
                title={t("closeTab")}
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TopBar;
