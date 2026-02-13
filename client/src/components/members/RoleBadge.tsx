/**
 * RoleBadge — Küçük renkli rol badge'i.
 *
 * CSS class'ları: .role-badge, .role-badge-dot
 *
 * Discord tarzı pill: sol tarafta renk noktası + rol ismi.
 * Renk noktası DB'den gelen role.color ile inline style alır.
 */

import type { Role } from "../../types";

type RoleBadgeProps = {
  role: Role;
};

function RoleBadge({ role }: RoleBadgeProps) {
  return (
    <span className="role-badge">
      <span
        className="role-badge-dot"
        style={{ backgroundColor: role.color || "#99AAB5" }}
      />
      {role.name}
    </span>
  );
}

export default RoleBadge;
