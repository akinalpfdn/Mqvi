/**
 * MemberList — Sağ panel: online/offline kullanıcılar, rol bazlı gruplama.
 *
 * Discord referans yapısı:
 * ┌─ Header ("Members")
 * ├─ Online section
 * │  ├─ Role group "Owner" (position DESC sıralı)
 * │  │  └─ MemberItem
 * │  ├─ Role group "Admin"
 * │  │  └─ MemberItem
 * │  └─ "Online — N" sayacı
 * └─ Offline section
 *    └─ "Offline — N" sayacı
 *       └─ MemberItem (dimmed)
 *
 * Gruplama mantığı:
 * Her üye en yüksek position'daki rolüne göre gruplanır.
 * Aynı rol grubundaki üyeler username'e göre alfabetik sıralanır.
 *
 * Spacing referansları (Discord):
 * - Header: h-header(48px), diğer panellerle hizalı
 * - Group başlıkları: uppercase, 24px üst padding, 8px alt
 * - Kullanıcı item'ları: 42px yükseklik, 8px padding
 */

import { useTranslation } from "react-i18next";
import { useMemberStore } from "../../stores/memberStore";
import MemberItem from "../members/MemberItem";
import type { MemberWithRoles, Role } from "../../types";

/**
 * getHighestRole — Üyenin en yüksek position'daki rolünü döner.
 * Grup başlığı ve sıralama bu role göre belirlenir.
 */
function getHighestRole(member: MemberWithRoles): Role | null {
  if (member.roles.length === 0) return null;
  return member.roles.reduce((highest, role) =>
    role.position > highest.position ? role : highest
  );
}

/**
 * RoleGroup — Aynı en yüksek role sahip üyeler grubu.
 */
type RoleGroup = {
  role: Role;
  members: MemberWithRoles[];
};

/**
 * groupByHighestRole — Üyeleri en yüksek rollerine göre gruplar.
 * Sonuç role position DESC sıralıdır.
 */
function groupByHighestRole(members: MemberWithRoles[]): RoleGroup[] {
  const groups = new Map<string, RoleGroup>();

  for (const member of members) {
    const highest = getHighestRole(member);
    if (!highest) continue;

    const existing = groups.get(highest.id);
    if (existing) {
      existing.members.push(member);
    } else {
      groups.set(highest.id, { role: highest, members: [member] });
    }
  }

  // Position DESC sırala, aynı group içindeki üyeleri username'e göre sırala
  const result = Array.from(groups.values()).sort(
    (a, b) => b.role.position - a.role.position
  );

  for (const group of result) {
    group.members.sort((a, b) => {
      const nameA = a.display_name ?? a.username;
      const nameB = b.display_name ?? b.username;
      return nameA.localeCompare(nameB);
    });
  }

  return result;
}

function MemberList() {
  const { t } = useTranslation("common");
  const members = useMemberStore((s) => s.members);
  const onlineUserIds = useMemberStore((s) => s.onlineUserIds);

  // Üyeleri online ve offline olarak ayır
  const onlineMembers = members.filter((m) => onlineUserIds.has(m.id));
  const offlineMembers = members.filter((m) => !onlineUserIds.has(m.id));

  // Online üyeleri role göre grupla
  const onlineGroups = groupByHighestRole(onlineMembers);

  // Rolsüz online üyeler (herhangi bir gruba girmeyen)
  const ungroupedOnline = onlineMembers.filter(
    (m) => m.roles.length === 0
  );

  // Offline üyeleri username'e göre sırala (gruplama yok)
  const sortedOffline = [...offlineMembers].sort((a, b) => {
    const nameA = a.display_name ?? a.username;
    const nameB = b.display_name ?? b.username;
    return nameA.localeCompare(nameB);
  });

  return (
    <div className="flex h-full w-member-list flex-col bg-background-secondary">
      {/* ─── Header ─── */}
      <div className="flex h-header shrink-0 items-center border-b border-background-tertiary px-4 shadow-sm">
        <h3 className="text-sm font-semibold text-text-secondary">
          {t("members")}
        </h3>
      </div>

      {/* ─── Member List ─── */}
      <div className="flex-1 overflow-y-auto px-3 pt-4">
        {/* Online section — role bazlı gruplar */}
        {onlineGroups.map((group) => (
          <div key={group.role.id} className="mb-1">
            {/* Role group header */}
            <div className="px-2 pb-1.5 pt-4">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.02em] text-text-muted">
                {group.role.name} — {group.members.length}
              </h3>
            </div>

            {/* Members in this role group */}
            {group.members.map((member) => (
              <MemberItem
                key={member.id}
                member={member}
                isOnline={true}
              />
            ))}
          </div>
        ))}

        {/* Rol grubu olmayan online üyeler (rolsüz) */}
        {ungroupedOnline.length > 0 && (
          <div className="mb-1">
            <div className="px-2 pb-1.5 pt-4">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.02em] text-text-muted">
                {t("online")} — {ungroupedOnline.length}
              </h3>
            </div>
            {ungroupedOnline.map((member) => (
              <MemberItem
                key={member.id}
                member={member}
                isOnline={true}
              />
            ))}
          </div>
        )}

        {/* Offline section */}
        {sortedOffline.length > 0 && (
          <div className="mb-1">
            <div className="px-2 pb-1.5 pt-4">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.02em] text-text-muted">
                {t("offline")} — {sortedOffline.length}
              </h3>
            </div>
            {sortedOffline.map((member) => (
              <MemberItem
                key={member.id}
                member={member}
                isOnline={false}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default MemberList;
