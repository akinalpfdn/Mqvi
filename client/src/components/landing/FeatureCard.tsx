/** FeatureCard — Single feature card with hover lift animation. */

import { useTranslation } from "react-i18next";
import RevealOnScroll from "./RevealOnScroll";

type FeatureCardProps = {
  tag: "live" | "beta";
  /** i18n key prefix — e.g. f1 -> f1_title, f1_desc */
  translationKey: string;
  /** Staggered animation delay in seconds */
  delay: number;
};

function FeatureCard({ tag, translationKey, delay }: FeatureCardProps) {
  const { t } = useTranslation("landing");

  return (
    <RevealOnScroll delay={delay}>
      <div className="lp-feature-card">
        <div className="lp-feature-card-line" />

        {/* Tag: Live or Beta */}
        <span className={`lp-feature-tag lp-feature-tag--${tag}`}>
          {t(tag === "live" ? "tag_live" : "tag_beta")}
        </span>

        {/* Title + description */}
        <h3>{t(`${translationKey}_title`)}</h3>
        <p>{t(`${translationKey}_desc`)}</p>
      </div>
    </RevealOnScroll>
  );
}

export default FeatureCard;
