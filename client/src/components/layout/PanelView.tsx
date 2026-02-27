/**
 * PanelView — Tek bir split panelin render'ı.
 *
 * CSS class'ları: .split-pane (container), .no-channel,
 * .channel-bar, .ch-hash, .ch-name (voice kanal header için)
 *
 * DropZoneOverlay ile VS Code tarzı split view:
 * - Tab sürüklenirken amber overlay ile 5 bölge gösterilir
 * - Kenar bölgelerine bırakma → panel split
 * - Merkeze bırakma → tab taşıma
 *
 * Drag event'leri bu component'in container div'inde yakalanır.
 * DropZoneOverlay sadece görsel render yapar (pointer-events: none).
 *
 * Tab tiplerine göre:
 * - text → ChatArea
 * - voice/screen → VoiceRoom + channel header
 * - Tab yoksa → boş durum
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../../stores/uiStore";
import { useChannelStore } from "../../stores/channelStore";
import { useIsMobile } from "../../hooks/useMediaQuery";
import PanelTabBar from "./PanelTabBar";
import ChatArea from "./ChatArea";
import VoiceRoom from "../voice/VoiceRoom";
import DMChat from "../dm/DMChat";
import FriendsView from "../friends/FriendsView";
import P2PCallScreen from "../p2p/P2PCallScreen";
import DropZoneOverlay, { calculateZone } from "./DropZoneOverlay";
import type { DropZone } from "./DropZoneOverlay";

type PanelViewProps = {
  panelId: string;
  sendTyping: (channelId: string) => void;
  sendDMTyping: (dmChannelId: string) => void;
};

function PanelView({ panelId, sendTyping, sendDMTyping }: PanelViewProps) {
  const { t } = useTranslation("chat");
  const isMobile = useIsMobile();
  const panel = useUIStore((s) => s.panels[panelId]);
  const setActivePanel = useUIStore((s) => s.setActivePanel);
  const splitPanel = useUIStore((s) => s.splitPanel);
  const moveTab = useUIStore((s) => s.moveTab);

  const categories = useChannelStore((s) => s.categories);

  const activeTab = panel?.tabs.find((t) => t.id === panel.activeTabId);

  const channel = activeTab
    ? categories.flatMap((cg) => cg.channels).find((ch) => ch.id === activeTab.channelId)
    : null;

  // ─── Drag state ───
  // activeZone: hangi drop zone'un highlight edileceği (null = overlay gizli)
  const [activeZone, setActiveZone] = useState<DropZone | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // dragEnter counter — nested child element'lerin yanlış dragLeave tetiklemesini engeller.
  // Her child'a girişte counter artar, çıkışta azalır. 0'a düşünce gerçekten çıkmış demektir.
  const enterCountRef = useRef(0);

  // dragend event'i — drag operasyonu bittiğinde (başarılı drop veya iptal)
  // overlay'ı temizle. PanelTabBar stopPropagation kullandığı için PanelView'ın
  // onDrop handler'ı her zaman tetiklenmeyebilir. dragend bunu garanti eder.
  useEffect(() => {
    function handleDragEnd() {
      setActiveZone(null);
      enterCountRef.current = 0;
    }
    document.addEventListener("dragend", handleDragEnd);
    return () => document.removeEventListener("dragend", handleDragEnd);
  }, []);

  const handleFocus = useCallback(() => {
    setActivePanel(panelId);
  }, [panelId, setActivePanel]);

  // ─── Drag event handler'ları ───
  // Container div'de yakalanır, DropZoneOverlay sadece görsel render yapar.

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    // Sadece tab sürüklemelerini kabul et
    if (!e.dataTransfer.types.includes("text/tab-id")) return;
    e.preventDefault();
    enterCountRef.current += 1;

    if (enterCountRef.current === 1 && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setActiveZone(calculateZone(e.clientX, e.clientY, rect));
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("text/tab-id")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";

    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setActiveZone(calculateZone(e.clientX, e.clientY, rect));
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    enterCountRef.current -= 1;

    if (enterCountRef.current <= 0) {
      enterCountRef.current = 0;
      setActiveZone(null);
    }
  }, []);

  /**
   * handleDrop — Tab bırakıldığında zone'a göre aksiyon alır.
   *
   * Zone → Action mapping:
   * - center: tab'ı bu panele taşı (moveTab)
   * - left/right: yatay split (horizontal)
   * - top/bottom: dikey split (vertical)
   *
   * Aynı panel kuralları:
   * - center zone + aynı panel → hiçbir şey yapma (zaten burada)
   * - edge zone + aynı panel + tek tab → yapma (split edilecek bir şey yok)
   * - edge zone + aynı panel + 2+ tab → split yap
   */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      enterCountRef.current = 0;
      setActiveZone(null);

      const tabId = e.dataTransfer.getData("text/tab-id");
      const fromPanelId = e.dataTransfer.getData("text/panel-id");
      if (!tabId || !fromPanelId || !containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const zone = calculateZone(e.clientX, e.clientY, rect);

      // Aynı panel kontrolü
      if (fromPanelId === panelId) {
        if (zone === "center") return;
        if (!panel || panel.tabs.length < 2) return;
      }

      switch (zone) {
        case "center":
          moveTab(fromPanelId, panelId, tabId);
          break;
        case "left":
          splitPanel(panelId, "horizontal", tabId, "before");
          break;
        case "right":
          splitPanel(panelId, "horizontal", tabId, "after");
          break;
        case "top":
          splitPanel(panelId, "vertical", tabId, "before");
          break;
        case "bottom":
          splitPanel(panelId, "vertical", tabId, "after");
          break;
      }
    },
    [panelId, panel, splitPanel, moveTab]
  );

  if (!panel) return null;

  // Mobilde drag-drop devre dışı — HTML5 DnD touch'ta çalışmaz
  const dragHandlers = isMobile
    ? {}
    : {
        onDragEnter: handleDragEnter,
        onDragOver: handleDragOver,
        onDragLeave: handleDragLeave,
        onDrop: handleDrop,
      };

  return (
    <div
      ref={containerRef}
      className="split-pane"
      style={{ flex: 1, position: "relative" }}
      onClick={handleFocus}
      {...dragHandlers}
    >
      {/* VS Code tarzı drop zone overlay — mobilde gösterilmez */}
      {!isMobile && <DropZoneOverlay activeZone={activeZone} />}

      {/* Panel-level tab bar — VS Code tarzı, her zaman gösterilir */}
      <PanelTabBar panelId={panelId} />

      {/* İçerik */}
      {!activeTab ? (
        <div className="no-channel">{t("noChannel")}</div>
      ) : activeTab.type === "text" ? (
        <ChatArea channelId={activeTab.channelId} channel={channel ?? null} sendTyping={sendTyping} />
      ) : activeTab.type === "dm" ? (
        <DMChat channelId={activeTab.channelId} sendDMTyping={sendDMTyping} />
      ) : activeTab.type === "friends" ? (
        <FriendsView />
      ) : activeTab.type === "p2p" ? (
        <P2PCallScreen />
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
