/**
 * MemberList — Right panel: online/offline users grouped by highest role.
 * Panel width is CSS-transitioned via .members-panel.open toggle.
 */

import { useTranslation } from "react-i18next";
import { useMemberStore, useActiveMembers } from "../../stores/memberStore";
import { useUIStore } from "../../stores/uiStore";
import { useMobileStore } from "../../stores/mobileStore";
import { useIsMobile } from "../../hooks/useMediaQuery";
import { useResizeHandle } from "../../hooks/useResizeHandle";
import MemberItem from "../members/MemberItem";
import { MemberSkeleton } from "../shared/Skeleton";
import type { MemberWithRoles, Role } from "../../types";

/** Member panel width bounds (px) */
const MEMBERS_MIN = 160;
const MEMBERS_MAX = 360;
const MEMBERS_DEFAULT = 240;

/** Returns the member's highest-position role (used for grouping). */
function getHighestRole(member: MemberWithRoles): Role | null {
  if (member.roles.length === 0) return null;
  return member.roles.reduce((highest, role) =>
    role.position > highest.position ? role : highest
  );
}

/** Members sharing the same highest role. */
type RoleGroup = {
  role: Role;
  members: MemberWithRoles[];
};

/** Groups members by highest role, sorted by role position DESC. */
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

  // Sort groups by position DESC, members within each group by username
  const result = Array.from(groups.values()).sort(
    (a, b) => b.role.position - a.role.position
  );

  for (const group of result) {
    group.members.sort((a, b) => {
      const nameA = a.display_name ?? a.username ?? "";
      const nameB = b.display_name ?? b.username ?? "";
      return nameA.localeCompare(nameB);
    });
  }

  return result;
}

function MemberList() {
  const { t } = useTranslation("common");
  const members = useActiveMembers();
  const isLoading = useMemberStore((s) => s.isLoading);
  const onlineUserIds = useMemberStore((s) => s.onlineUserIds);
  const toggleMembers = useUIStore((s) => s.toggleMembers);
  const membersOpen = useUIStore((s) => s.membersOpen);
  const closeRightDrawer = useMobileStore((s) => s.closeRightDrawer);
  const isMobile = useIsMobile();

  const { width, handleMouseDown, isDragging } = useResizeHandle({
    initialWidth: MEMBERS_DEFAULT,
    minWidth: MEMBERS_MIN,
    maxWidth: MEMBERS_MAX,
    direction: "left",
    storageKey: "mqvi_members_width",
  });

  // Split members into online/offline
  const onlineMembers = members.filter((m) => onlineUserIds.has(m.id));
  const offlineMembers = members.filter((m) => !onlineUserIds.has(m.id));

  // Group online members by role
  const onlineGroups = groupByHighestRole(onlineMembers);

  // Online members with no roles (ungrouped)
  const ungroupedOnline = onlineMembers.filter(
    (m) => m.roles.length === 0
  );

  // Offline members sorted by name (no grouping)
  const sortedOffline = [...offlineMembers].sort((a, b) => {
    const nameA = a.display_name ?? a.username ?? "";
    const nameB = b.display_name ?? b.username ?? "";
    return nameA.localeCompare(nameB);
  });

  /** Dynamic width when open, 0 when closed */
  const panelWidth = membersOpen ? width : 0;

  return (
    <div
      className={`members-panel${membersOpen ? " open" : ""}`}
      style={membersOpen ? { width: panelWidth } : undefined}
    >
      {/* Resize handle — left edge, only when open */}
      {membersOpen && (
        <div
          className={`resize-handle resize-handle-v${isDragging ? " active" : ""}`}
          onMouseDown={handleMouseDown}
        />
      )}
      <div className="members-inner app-panel" style={{ width }}>
        {/* ─── Header ─── */}
        <div className="members-header">
          <h3>{t("members")}</h3>
          <button onClick={isMobile ? closeRightDrawer : toggleMembers}>✕</button>
        </div>

        {/* ─── Member List ─── */}
        <div className="members-list">
          {/* Skeleton while loading */}
          {isLoading && members.length === 0 && (
            <MemberSkeleton count={8} />
          )}

          {/* Online — grouped by role */}
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

          {/* Ungrouped online members */}
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
