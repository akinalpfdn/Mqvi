/**
 * PanelView — Tek bir split panelin render'ı.
 *
 * CSS class'ları: .split-pane (container), .no-channel,
 * .channel-bar, .ch-hash, .ch-name (voice kanal header için)
 *
 * Tab tiplerine göre:
 * - text → ChatArea
 * - voice/screen → VoiceRoom + channel header
 * - Tab yoksa → boş durum
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { useChannelStore } from "../../stores/channelStore";
import PanelTabBar from "./PanelTabBar";
import ChatArea from "./ChatArea";
import VoiceRoom from "../voice/VoiceRoom";

type PanelViewProps = {
  panelId: string;
};

function PanelView({ panelId }: PanelViewProps) {
  const { t } = useTranslation("chat");
  const panel = useUIStore((s) => s.panels[panelId]);
  const setActivePanel = useUIStore((s) => s.setActivePanel);
  const splitPanel = useUIStore((s) => s.splitPanel);
  const moveTab = useUIStore((s) => s.moveTab);

  const categories = useChannelStore((s) => s.categories);

  const activeTab = panel?.tabs.find((t) => t.id === panel.activeTabId);

  const channel = activeTab
    ? categories.flatMap((cg) => cg.channels).find((ch) => ch.id === activeTab.channelId)
    : null;

  const handleFocus = useCallback(() => {
    setActivePanel(panelId);
  }, [panelId, setActivePanel]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const tabId = e.dataTransfer.getData("text/tab-id");
      const fromPanelId = e.dataTransfer.getData("text/panel-id");

      if (!tabId || !fromPanelId) return;
      if (fromPanelId === panelId) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / rect.width;
      const relY = (e.clientY - rect.top) / rect.height;

      const distLeft = relX;
      const distRight = 1 - relX;
      const distTop = relY;
      const distBottom = 1 - relY;
      const minDist = Math.min(distLeft, distRight, distTop, distBottom);
      const edgeThreshold = 0.25;

      if (minDist < edgeThreshold) {
        if (minDist === distLeft || minDist === distRight) {
          splitPanel(panelId, "horizontal", tabId);
        } else {
          splitPanel(panelId, "vertical", tabId);
        }
      } else {
        moveTab(fromPanelId, panelId, tabId);
      }
    },
    [panelId, splitPanel, moveTab]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  if (!panel) return null;

  return (
    <div
      className="split-pane"
      style={{ flex: 1 }}
      onClick={handleFocus}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Panel-level tab bar — sadece 2+ tab varsa */}
      {panel.tabs.length > 1 && (
        <PanelTabBar panelId={panelId} />
      )}

      {/* İçerik */}
      {!activeTab ? (
        <div className="no-channel">{t("noChannel")}</div>
      ) : activeTab.type === "text" ? (
        <ChatArea channelId={activeTab.channelId} channel={channel ?? null} />
      ) : (
        <div className="voice-room">
          {channel && (
            <div className="channel-bar">
              <span className="ch-hash">
                {activeTab.type === "voice" ? "\uD83D\uDD0A" : "\uD83D\uDDA5"}
              </span>
              <span className="ch-name">{channel.name}</span>
            </div>
          )}
          <VoiceRoom />
        </div>
      )}
    </div>
  );
}

export default PanelView;
