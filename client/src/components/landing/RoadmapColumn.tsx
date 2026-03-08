/** RoadmapColumn — Single roadmap column (Shipped / In Progress / Planned). */

import { useTranslation } from "react-i18next";
import type { RoadmapItem } from "./landingData";

type RoadmapColumnProps = {
  title: string;
  color: string;
  items: RoadmapItem[];
};

function RoadmapColumn({ title, color, items }: RoadmapColumnProps) {
  const { t } = useTranslation("landing");

  return (
    <div className="lp-roadmap-col">
      {/* Header */}
      <div
        className="lp-roadmap-col-header"
        style={{ background: `${color}12`, color }}
      >
        <div className="lp-roadmap-col-dot" style={{ background: color }} />
        {title}
      </div>

      {/* Items */}
      <div className="lp-roadmap-col-body">
        {items.map((item) => (
          <div key={item.key} className="lp-roadmap-item">
            {t(item.key)}
          </div>
        ))}
      </div>
    </div>
  );
}

export default RoadmapColumn;
