/**
 * MemberItem — Üye listesinde tek bir kullanıcı satırı.
 *
 * Discord referans spacing'leri:
 * - 42px yükseklik
 * - 32px avatar, 8px padding
 * - Status dot: avatar'ın sağ altında
 * - İsim: en yüksek rolün rengiyle gösterilir
 * - Offline üyeler dimmed (opacity düşük)
 *
 * MemberCard popup: React Portal ile body seviyesinde render edilir.
 * Neden Portal?
 * MemberList'teki overflow-y-auto div, absolutely positioned child'ları kırpar.
 * Portal ile card'ı overflow container'ın dışına, body'ye render ediyoruz.
 * Pozisyon, tıklanan butonun getBoundingClientRect()'i ile hesaplanır.
 */

import { useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { MemberWithRoles } from "../../types";
import MemberCard from "./MemberCard";

type MemberItemProps = {
  member: MemberWithRoles;
  isOnline: boolean;
};

/**
 * getHighestRole — Üyenin en yüksek position'daki rolünü döner.
 * Bu rol, ismin rengini belirler (Discord'daki gibi).
 */
function getHighestRole(member: MemberWithRoles) {
  if (member.roles.length === 0) return null;
  return member.roles.reduce((highest, role) =>
    role.position > highest.position ? role : highest
  );
}

/**
 * getStatusColor — Status'a göre Tailwind renk sınıfı döner.
 */
function getStatusColor(status: string): string {
  switch (status) {
    case "online":
      return "bg-status-online";
    case "idle":
      return "bg-status-idle";
    case "dnd":
      return "bg-status-dnd";
    default:
      return "bg-status-offline";
  }
}

function MemberItem({ member, isOnline }: MemberItemProps) {
  const [showCard, setShowCard] = useState(false);
  const [cardPos, setCardPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const highestRole = getHighestRole(member);

  const nameColor = highestRole?.color || undefined;
  const displayName = member.display_name ?? member.username;

  const handleClick = useCallback(() => {
    if (showCard) {
      setShowCard(false);
      return;
    }

    // Butonun ekran pozisyonunu al ve card'ı soluna konumla
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const cardWidth = 288; // w-72 = 18rem = 288px
      const gap = 8;

      // Card'ın top pozisyonu: butonun üst kenarından başlar,
      // ama ekranın altına taşarsa yukarı kaydır
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
    <div className="px-1">
      <button
        ref={buttonRef}
        onClick={handleClick}
        className={`flex h-11 w-full items-center gap-3.5 rounded-md px-2.5 transition-colors hover:bg-surface-hover ${
          !isOnline ? "opacity-40" : ""
        }`}
      >
        {/* Avatar — avatar_url varsa resim, yoksa ilk harf */}
        <div className="relative shrink-0">
          {member.avatar_url ? (
            <img
              src={member.avatar_url}
              alt={displayName}
              className="h-8 w-8 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">
              {member.username.charAt(0).toUpperCase()}
            </div>
          )}
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background-secondary ${getStatusColor(
              member.status
            )}`}
          />
        </div>

        {/* Username — en yüksek rolün renginde */}
        <span
          className="truncate text-sm font-medium leading-5"
          style={nameColor ? { color: nameColor } : undefined}
        >
          {displayName}
        </span>
      </button>

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
    </div>
  );
}

export default MemberItem;
