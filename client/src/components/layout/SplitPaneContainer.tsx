/**
 * SplitPaneContainer — Recursive split pane renderer.
 * Desktop: recursive split tree with resize handles.
 * Mobile: flattened — only the active panel is rendered.
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

/** Finds the active panel in the layout tree, falls back to first leaf. */
function findActiveLeaf(node: LayoutNode, activePanelId: string): string {
  if (node.type === "leaf") return node.panelId;
  const left = findLeafContaining(node.children[0], activePanelId);
  if (left) return activePanelId;
  const right = findLeafContaining(node.children[1], activePanelId);
  if (right) return activePanelId;
  // Active panel not in this subtree — fall back to first leaf
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

  // Mobile: render only the active panel, no splits
  if (isMobile) {
    const activePanelId = useUIStore.getState().activePanelId;
    const panelId = findActiveLeaf(node, activePanelId);
    return <PanelView panelId={panelId} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />;
  }

  // Desktop: recursive split
  if (node.type === "leaf") {
    return <PanelView panelId={node.panelId} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />;
  }

  const isVertical = node.direction === "vertical";

  return (
    <div className={`split-container${isVertical ? " vertical" : ""}`}>
      {/* Left / Top panel */}
      <div className="split-pane" style={{ flex: node.ratio }}>
        <SplitPaneContainer node={node.children[0]} path={[...path, 0]} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />
      </div>

      {/* Resize handle */}
      <SplitResizeHandle
        direction={node.direction}
        path={path}
        ratio={node.ratio}
      />

      {/* Right / Bottom panel */}
      <div className="split-pane" style={{ flex: 1 - node.ratio }}>
        <SplitPaneContainer node={node.children[1]} path={[...path, 1]} sendTyping={sendTyping} sendDMTyping={sendDMTyping} />
      </div>
    </div>
  );
}

/** Draggable divider between split panels. */
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
