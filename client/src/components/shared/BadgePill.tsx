/**
 * BadgePill — Renders a badge as a compact icon+text pill.
 *
 * Used in MemberCard, chat messages, DM messages, and DM profile card.
 * Supports both built-in SVG icons and custom uploaded images.
 * Background is solid or gradient based on color1/color2.
 *
 * Sizes:
 *  - "sm" (default): compact inline pill for message rows
 *  - "md": slightly larger for profile cards
 */

import { getBadgeIcon } from "../../utils/badgeIcons";
import type { Badge } from "../../types";

type BadgePillProps = {
  badge: Badge;
  size?: "sm" | "md";
};

function BadgePill({ badge, size = "sm" }: BadgePillProps) {
  const bg = badge.color2
    ? `linear-gradient(135deg, ${badge.color1}, ${badge.color2})`
    : badge.color1;

  const cls = `badge-pill badge-pill-${size}`;

  return (
    <span className={cls} style={{ background: bg }} title={badge.name}>
      <span className="badge-pill-icon">
        {badge.icon_type === "builtin" ? (
          getBadgeIcon(badge.icon)?.svg ?? null
        ) : (
          <img src={badge.icon} alt="" className="badge-pill-custom-img" />
        )}
      </span>
      <span className="badge-pill-text">{badge.name}</span>
    </span>
  );
}

export default BadgePill;
