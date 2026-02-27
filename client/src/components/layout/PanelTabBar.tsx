/**
 * PanelTabBar — VS Code tarzı panel-level tab çubuğu.
 *
 * Her panel her zaman kendi tab bar'ını gösterir (tek panel dahil).
 * Tab'lar sürüklenebilir ve başka panellere bırakılabilir.
 * Tab bar kendisi de drop target — başka panelden tab sürüklenip
 * bar'a bırakılınca merge (moveTab) yapılır.
 *
 * CSS class'ları: .panel-tab-bar, .panel-tab, .panel-tab.active,
 * .panel-tab-close, .panel-tab-dot, .tab-icon, .tab-label
 */

import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { useIsMobile } from "../../hooks/useMediaQuery";

type PanelTabBarProps = {
  panelId: string;
};

function PanelTabBar({ panelId }: PanelTabBarProps) {
  const { t } = useTranslation("common");
  const isMobile = useIsMobile();
  const panel = useUIStore((s) => s.panels[panelId]);
  const activePanelId = useUIStore((s) => s.activePanelId);
  const setActiveTab = useUIStore((s) => s.setActiveTab);
  const closeTab = useUIStore((s) => s.closeTab);
  const moveTab = useUIStore((s) => s.moveTab);

  // Drop hover state — tab bar'a tab sürüklenince highlight
  const [dropHover, setDropHover] = useState(false);
  const enterCountRef = useRef(0);

  // ─── Tab bar drop handlers (merge target) ───

  const handleBarDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("text/tab-id")) return;
    e.preventDefault();
    enterCountRef.current += 1;
    if (enterCountRef.current === 1) setDropHover(true);
  }, []);

  const handleBarDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("text/tab-id")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handleBarDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    enterCountRef.current -= 1;
    if (enterCountRef.current <= 0) {
      enterCountRef.current = 0;
      setDropHover(false);
    }
  }, []);

  const handleBarDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation(); // PanelView'daki drop handler'ı tetiklemesin
      enterCountRef.current = 0;
      setDropHover(false);

      const tabId = e.dataTransfer.getData("text/tab-id");
      const fromPanelId = e.dataTransfer.getData("text/panel-id");
      if (!tabId || !fromPanelId) return;

      // Aynı panele drop → no-op
      if (fromPanelId === panelId) return;

      moveTab(fromPanelId, panelId, tabId);
    },
    [panelId, moveTab]
  );

  if (!panel) return null;

  const isActivePanel = activePanelId === panelId;
  let barClass = "panel-tab-bar";
  if (isActivePanel) barClass += " active-panel";
  if (dropHover) barClass += " drop-hover";
  if (isMobile) barClass += " mobile";

  // Mobilde drag-drop devre dışı — HTML5 DnD touch'ta çalışmaz
  const dragHandlers = isMobile
    ? {}
    : {
        onDragEnter: handleBarDragEnter,
        onDragOver: handleBarDragOver,
        onDragLeave: handleBarDragLeave,
        onDrop: handleBarDrop,
      };

  return (
    <div className={barClass} {...dragHandlers}>
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
            draggable={!isMobile}
            onDragStart={
              isMobile
                ? undefined
                : (e) => {
                    e.dataTransfer.setData("text/tab-id", tab.id);
                    e.dataTransfer.setData("text/panel-id", panelId);
                    e.dataTransfer.effectAllowed = "move";
                  }
            }
            onClick={() => setActiveTab(panelId, tab.id)}
          >
            {/* Type-based ikon */}
            <span className="tab-icon">
              {tab.type === "text" && "#"}
              {tab.type === "voice" && "\uD83D\uDD0A"}
              {tab.type === "screen" && "\uD83D\uDDA5"}
              {tab.type === "dm" && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              )}
              {tab.type === "friends" && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              )}
              {tab.type === "p2p" && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
                </svg>
              )}
            </span>

            {/* Label */}
            <span className="tab-label">{tab.label}</span>

            {/* Unread dot — aktif olmayan tab'da okunmamış mesaj varsa */}
            {tab.hasUnread && !isActive && (
              <span className="panel-tab-dot" />
            )}

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
