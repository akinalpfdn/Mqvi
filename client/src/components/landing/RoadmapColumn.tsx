/**
 * RoadmapColumn — Roadmap section'ında tek bir sütun (Shipped / In Progress / Planned).
 *
 * Üst kısımda renkli header + dot, alt kısımda öğe listesi.
 *
 * CSS: .lp-roadmap-col, .lp-roadmap-col-header, .lp-roadmap-col-body,
 *       .lp-roadmap-item (landing.css)
 */

import { useTranslation } from "react-i18next";
import type { RoadmapItem } from "./landingData";

type RoadmapColumnProps = {
  /** Sütun başlığı (çevrilmiş) */
  title: string;
  /** Header ve dot rengi */
  color: string;
  /** Roadmap öğeleri */
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

      {/* Öğe listesi */}
      <div className="lp-roadmap-col-body">
        {items.map((item) => (
          <div key={item.key} className="lp-roadmap-item">
            <span className="lp-roadmap-item-icon">{item.icon}</span>
            {t(item.key)}
          </div>
        ))}
      </div>
    </div>
  );
}

export default RoadmapColumn;
