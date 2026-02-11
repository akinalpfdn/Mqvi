/**
 * RoleBadge — Küçük renkli rol badge'i.
 *
 * Kullanım:
 * - MemberCard'da üyenin rollerini göstermek için
 * - Rol yönetimi panelinde rol ismini görüntülemek için
 *
 * Discord tarzı: Küçük pill şeklinde, sol tarafta renk noktası.
 */

import type { Role } from "../../types";

type RoleBadgeProps = {
  role: Role;
};

function RoleBadge({ role }: RoleBadgeProps) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-background-tertiary px-2 py-0.5 text-xs font-medium text-text-secondary">
      <span
        className="h-3 w-3 shrink-0 rounded-full"
        style={{ backgroundColor: role.color || "#99AAB5" }}
      />
      {role.name}
    </span>
  );
}

export default RoleBadge;
