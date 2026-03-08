/** RoleBadge — Colored pill with dot + role name. */

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
