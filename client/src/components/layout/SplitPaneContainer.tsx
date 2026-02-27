/**
 * SplitPaneContainer — Recursive split pane renderer.
 *
 * Desktop: Recursive split tree — her split node iki çocuk + resize handle.
 * Mobil: Flatten — sadece aktif panel gösterilir, split yok.
 *
 * CSS class'ları: .split-container, .split-container.vertical,
 * .split-pane, .split-handle, .split-handle.horizontal, .split-handle.vertical,
 * .split-handle-dot
 *
 * "leaf" node → PanelView, "split" node → recursive split + resize handle
 */

import { useCallback, useRef, useState } from "react";
import type { LayoutNode } from "../../stores/uiStore";
import { useUIStore } from "../../stores/uiStore";
import { useIsMobile } from "../../hooks/useMediaQuery";
import PanelView from "./PanelView";

type SplitPaneContainerProps = {
  node: LayoutNode;
  path?: number[];
  sendTyping: (channelId: string) => void;
  sendDMTyping: (dmChannelId: string) => void;
};

/**
 * findActiveLeaf — Layout ağacında aktif paneli bulur.
 * Bulamazsa ilk leaf'i döner.
 */
function findActiveLeaf(node: LayoutNode, activePanelId: string): string {
  if (node.type === "leaf") return node.panelId;
  const left = findLeafContaining(node.children[0], activePanelId);
  if (left) return activePanelId;
  const right = findLeafContaining(node.children[1], activePanelId);
  if (right) return activePanelId;
  // Aktif panel bu subtree'de değil — ilk leaf'i döner
  return firstLeaf(node);
}

function findLeafContaining(node: LayoutNode, panelId: string): boolean {
  if (node.type === "leaf") return node.panelId === panelId;
  return findLeafContaining(node.children[0], panelId) || findLeafContaining(node.children[1], panelId);
}

function firstLeaf(node: LayoutNode): string {
  if (node.type === "leaf") return node.panelId;
  return firstLeaf(node.children[0]);
}

function SplitPaneContainer({ node, path = [], sendTyping, sendDMTyping }: SplitPaneContainerProps) {
  const isMobile = useIsMobile();

  // Mobilde: sadece aktif paneli göster, split yok
  if (isMobile) {
    const activePanelId = useUIStore.getState().activePanelId;
    const panelId = findActiveLeaf(node, activePanelId);
    return <PanelView panelId={panelId} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />;
  }

  // Desktop: recursive split render
  if (node.type === "leaf") {
    return <PanelView panelId={node.panelId} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />;
  }

  const isVertical = node.direction === "vertical";

  return (
    <div className={`split-container${isVertical ? " vertical" : ""}`}>
      {/* Sol / Üst panel */}
      <div className="split-pane" style={{ flex: node.ratio }}>
        <SplitPaneContainer node={node.children[0]} path={[...path, 0]} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />
      </div>

      {/* Resize handle */}
      <SplitResizeHandle
        direction={node.direction}
        path={path}
        ratio={node.ratio}
      />

      {/* Sağ / Alt panel */}
      <div className="split-pane" style={{ flex: 1 - node.ratio }}>
        <SplitPaneContainer node={node.children[1]} path={[...path, 1]} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />
      </div>
    </div>
  );
}

/**
 * SplitResizeHandle — Split paneller arası sürüklenebilir ayırıcı.
 */
type ResizeHandleProps = {
  direction: "horizontal" | "vertical";
  path: number[];
  ratio: number;
};

function SplitResizeHandle({ direction, path }: ResizeHandleProps) {
  const setSplitRatio = useUIStore((s) => s.setSplitRatio);
  const [isDragging, setIsDragging] = useState(false);
  const handleRef = useRef<HTMLDivElement>(null);

  const isHorizontal = direction === "horizontal";

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);

      const parent = handleRef.current?.parentElement;
      if (!parent) return;

      const parentRect = parent.getBoundingClientRect();

      function onMouseMove(ev: MouseEvent) {
        const newRatio = isHorizontal
          ? (ev.clientX - parentRect.left) / parentRect.width
          : (ev.clientY - parentRect.top) / parentRect.height;

        setSplitRatio(path, newRatio);
      }

      function onMouseUp() {
        setIsDragging(false);
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      }

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [isHorizontal, path, setSplitRatio]
  );

  const handleClass = `split-handle ${isHorizontal ? "horizontal" : "vertical"}${isDragging ? " active" : ""}`;

  return (
    <div
      ref={handleRef}
      className={handleClass}
      onMouseDown={handleMouseDown}
    >
      <div className="split-handle-dot" />
    </div>
  );
}

export default SplitPaneContainer;
