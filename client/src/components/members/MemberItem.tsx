/**
 * MemberItem — Üye listesinde tek bir kullanıcı satırı.
 *
 * CSS class'ları: .member, .member.offline, .member-av-wrap,
 * .member-status, .status-on, .status-idle, .status-dnd, .status-off,
 * .member-info, .member-name, .member-activity
 *
 * MemberCard popup: React Portal ile body seviyesinde render edilir.
 */

import { useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import Avatar from "../shared/Avatar";
import type { MemberWithRoles } from "../../types";
import MemberCard from "./MemberCard";

type MemberItemProps = {
  member: MemberWithRoles;
  isOnline: boolean;
};

function getHighestRole(member: MemberWithRoles) {
  if (member.roles.length === 0) return null;
  return member.roles.reduce((highest, role) =>
    role.position > highest.position ? role : highest
  );
}

function getRoleType(member: MemberWithRoles): "admin" | "mod" | null {
  const highest = getHighestRole(member);
  if (!highest) return null;

  const name = highest.name.toLowerCase();
  if (name.includes("admin") || name.includes("owner")) return "admin";
  if (name.includes("mod")) return "mod";
  return null;
}

function getStatusClass(status: string): string {
  switch (status) {
    case "online":
      return "status-on";
    case "idle":
      return "status-idle";
    case "dnd":
      return "status-dnd";
    default:
      return "status-off";
  }
}

function MemberItem({ member, isOnline }: MemberItemProps) {
  const [showCard, setShowCard] = useState(false);
  const [cardPos, setCardPos] = useState({ top: 0, left: 0 });
  const itemRef = useRef<HTMLDivElement>(null);
  const highestRole = getHighestRole(member);
  const roleType = getRoleType(member);

  const nameColor = highestRole?.color || undefined;
  const displayName = member.display_name ?? member.username;

  const handleClick = useCallback(() => {
    if (showCard) {
      setShowCard(false);
      return;
    }

    if (itemRef.current) {
      const rect = itemRef.current.getBoundingClientRect();
      const cardWidth = 288;
      const gap = 8;

      let top = rect.top;
      const cardEstimatedHeight = 350;
      if (top + cardEstimatedHeight > window.innerHeight) {
        top = window.innerHeight - cardEstimatedHeight - 16;
      }
      if (top < 8) top = 8;

      setCardPos({
        top,
        left: rect.left - cardWidth - gap,
      });
    }

    setShowCard(true);
  }, [showCard]);

  return (
    <>
      <div
        ref={itemRef}
        onClick={handleClick}
        className={`member${!isOnline ? " offline" : ""}`}
      >
        {/* Avatar + status dot */}
        <div className="member-av-wrap">
          <Avatar
            name={member.username}
            role={roleType}
            avatarUrl={member.avatar_url ?? undefined}
            size={22}
          />
          <span className={`member-status ${getStatusClass(member.status)}`} />
        </div>

        {/* Name + Activity */}
        <div className="member-info">
          <span
            className="member-name"
            style={nameColor ? { color: nameColor } : undefined}
          >
            {displayName}
          </span>

          {member.custom_status && (
            <span className="member-activity">
              {member.custom_status}
            </span>
          )}
        </div>
      </div>

      {/* MemberCard — Portal ile body'ye render edilir */}
      {showCard &&
        createPortal(
          <MemberCard
            member={member}
            position={cardPos}
            onClose={() => setShowCard(false)}
          />,
          document.body
        )}
    </>
  );
}

export default MemberItem;
