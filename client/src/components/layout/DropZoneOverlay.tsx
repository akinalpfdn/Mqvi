/**
 * DropZoneOverlay — Visual drop zones shown during tab drag.
 *
 * Pure visual (pointer-events: none). All drag events are handled
 * by the parent PanelView which passes activeZone as a prop.
 */

export type DropZone = "left" | "right" | "top" | "bottom" | "center";

type DropZoneOverlayProps = {
  activeZone: DropZone | null;
};

const ZONES: DropZone[] = ["left", "right", "top", "bottom", "center"];

/**
 * Determines which zone the cursor is in based on relative distance
 * to each edge. Closest edge within 25% threshold wins; otherwise center.
 * Exported for use by PanelView.
 */
export function calculateZone(
  clientX: number,
  clientY: number,
  rect: DOMRect
): DropZone {
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;

  const distLeft = relX;
  const distRight = 1 - relX;
  const distTop = relY;
  const distBottom = 1 - relY;

  const minDist = Math.min(distLeft, distRight, distTop, distBottom);
  const threshold = 0.25;

  if (minDist >= threshold) return "center";
  if (minDist === distLeft) return "left";
  if (minDist === distRight) return "right";
  if (minDist === distTop) return "top";
  return "bottom";
}

function DropZoneOverlay({ activeZone }: DropZoneOverlayProps) {
  if (!activeZone) return null;

  return (
    <div className="drop-zone-overlay active">
      {ZONES.map((zone) => (
        <div
          key={zone}
          className={`drop-zone drop-zone-${zone}${activeZone === zone ? " highlight" : ""}`}
        />
      ))}
    </div>
  );
}

export default DropZoneOverlay;
