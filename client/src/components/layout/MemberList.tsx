/**
 * MemberList — Sağ panel: online/offline kullanıcılar, rol bazlı gruplama.
 *
 * CSS class'ları: .members-panel, .members-panel.open, .members-inner,
 * .members-header, .members-list, .member-label
 *
 * Panel genişliği CSS transition ile yönetilir:
 * .members-panel { width:0; overflow:hidden; transition:width .25s }
 * .members-panel.open { width:200px; }
 *
 * membersOpen state'i .open class'ını toggle eder.
 */

import { useTranslation } from "react-i18next";
import { useMemberStore } from "../../stores/memberStore";
import { useUIStore } from "../../stores/uiStore";
import { useResizeHandle } from "../../hooks/useResizeHandle";
import MemberItem from "../members/MemberItem";
import { MemberSkeleton } from "../shared/Skeleton";
import type { MemberWithRoles, Role } from "../../types";

/** Member panel genişlik sınırları (px) */
const MEMBERS_MIN = 160;
const MEMBERS_MAX = 360;
const MEMBERS_DEFAULT = 240;

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
  const isLoading = useMemberStore((s) => s.isLoading);
  const onlineUserIds = useMemberStore((s) => s.onlineUserIds);
  const toggleMembers = useUIStore((s) => s.toggleMembers);
  const membersOpen = useUIStore((s) => s.membersOpen);

  const { width, handleMouseDown, isDragging } = useResizeHandle({
    initialWidth: MEMBERS_DEFAULT,
    minWidth: MEMBERS_MIN,
    maxWidth: MEMBERS_MAX,
    direction: "left",
    storageKey: "mqvi_members_width",
  });

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

  /** Panel açıkken dinamik genişlik, kapalıyken 0 */
  const panelWidth = membersOpen ? width : 0;

  return (
    <div
      className={`members-panel${membersOpen ? " open" : ""}`}
      style={membersOpen ? { width: panelWidth } : undefined}
    >
      {/* Resize handle — sol kenarda, sadece açıkken */}
      {membersOpen && (
        <div
          className={`resize-handle resize-handle-v${isDragging ? " active" : ""}`}
          onMouseDown={handleMouseDown}
        />
      )}
      <div className="members-inner" style={{ width }}>
        {/* ─── Header ─── */}
        <div className="members-header">
          <h3>{t("members")}</h3>
          <button onClick={toggleMembers}>✕</button>
        </div>

        {/* ─── Member List ─── */}
        <div className="members-list">
          {/* Skeleton UI — yüklenirken gösterilir */}
          {isLoading && members.length === 0 && (
            <MemberSkeleton count={8} />
          )}

          {/* Online section — role bazlı gruplar */}
          {onlineGroups.map((group) => (
            <div key={group.role.id}>
              <div className="member-label">
                {group.role.name} — {group.members.length}
              </div>
              {group.members.map((member) => (
                <MemberItem
                  key={member.id}
                  member={member}
                  isOnline={true}
                />
              ))}
            </div>
          ))}

          {/* Rolsüz online üyeler */}
          {ungroupedOnline.length > 0 && (
            <div>
              <div className="member-label">
                {t("online")} — {ungroupedOnline.length}
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
            <div>
              <div className="member-label">
                {t("offline")} — {sortedOffline.length}
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
    </div>
  );
}

export default MemberList;
