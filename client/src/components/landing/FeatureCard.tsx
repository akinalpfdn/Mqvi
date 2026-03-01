/**
 * FeatureCard — Tek bir özellik kartı.
 *
 * Features grid'inde 3'lü sütun halinde gösterilir.
 * Hover'da üst kenar çizgisi açılır ve kart yukarı kalkar.
 *
 * CSS: .lp-feature-card, .lp-feature-card-line, .lp-feature-tag,
 *       .lp-feature-icon (landing.css)
 */

import { useTranslation } from "react-i18next";
import RevealOnScroll from "./RevealOnScroll";

type FeatureCardProps = {
  tag: "live" | "beta";
  /** i18n çeviri key prefix'i — f1 → f1_title, f1_desc */
  translationKey: string;
  /** Sıralı animasyon gecikmesi (saniye) */
  delay: number;
};

function FeatureCard({ tag, translationKey, delay }: FeatureCardProps) {
  const { t } = useTranslation("landing");

  return (
    <RevealOnScroll delay={delay}>
      <div className="lp-feature-card">
        {/* Hover'da açılan üst kenar çizgisi */}
        <div className="lp-feature-card-line" />

        {/* Tag: Live veya Beta */}
        <span className={`lp-feature-tag lp-feature-tag--${tag}`}>
          {t(tag === "live" ? "tag_live" : "tag_beta")}
        </span>

        {/* Başlık + açıklama */}
        <h3>{t(`${translationKey}_title`)}</h3>
        <p>{t(`${translationKey}_desc`)}</p>
      </div>
    </RevealOnScroll>
  );
}

export default FeatureCard;
