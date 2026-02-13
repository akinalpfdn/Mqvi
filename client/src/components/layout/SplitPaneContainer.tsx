/**
 * SplitPaneContainer — Recursive split pane renderer.
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
import PanelView from "./PanelView";

type SplitPaneContainerProps = {
  node: LayoutNode;
  path?: number[];
};

function SplitPaneContainer({ node, path = [] }: SplitPaneContainerProps) {
  if (node.type === "leaf") {
    return <PanelView panelId={node.panelId} />;
  }

  const isVertical = node.direction === "vertical";

  return (
    <div className={`split-container${isVertical ? " vertical" : ""}`}>
      {/* Sol / Üst panel */}
      <div className="split-pane" style={{ flex: node.ratio }}>
        <SplitPaneContainer node={node.children[0]} path={[...path, 0]} />
      </div>

      {/* Resize handle */}
      <SplitResizeHandle
        direction={node.direction}
        path={path}
        ratio={node.ratio}
      />

      {/* Sağ / Alt panel */}
      <div className="split-pane" style={{ flex: 1 - node.ratio }}>
        <SplitPaneContainer node={node.children[1]} path={[...path, 1]} />
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
