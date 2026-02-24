/**
 * VoiceUserContextMenu — Sidebar voice kullanıcıları için sağ tık menüsü.
 *
 * Portal ile document.body'ye render edilir — sidebar overflow:hidden'ı aşar.
 *
 * İçerik:
 * 1. Header: Avatar + display name
 * 2. Volume slider (0-200%)
 * 3. Local mute toggle (sadece bu client için)
 * 4. Admin: Server mute (herkes için sustur)
 * 5. Admin: Server deafen (herkes için sağırlaştır)
 *
 * CSS class'ları: .voice-ctx-menu, .voice-ctx-header, .voice-ctx-body,
 * .voice-ctx-slider, .voice-ctx-range, .voice-ctx-vol-value,
 * .voice-ctx-divider, .voice-ctx-item
 */

import { useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAuthStore } from "../../stores/authStore";
import { useMemberStore } from "../../stores/memberStore";
import { hasPermission, Permissions } from "../../utils/permissions";
import Avatar from "../shared/Avatar";

type VoiceUserContextMenuProps = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  position: { x: number; y: number };
  onClose: () => void;
  /** WS event gönderme fonksiyonu — admin state update için */
  onAdminStateUpdate?: (targetUserId: string, isServerMuted?: boolean, isServerDeafened?: boolean) => void;
};

function VoiceUserContextMenu({
  userId,
  username,
  displayName,
  avatarUrl,
  position,
  onClose,
  onAdminStateUpdate,
}: VoiceUserContextMenuProps) {
  const { t } = useTranslation("voice");
  const menuRef = useRef<HTMLDivElement>(null);

  // ─── Store Selectors ───
  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const setUserVolume = useVoiceStore((s) => s.setUserVolume);
  const localMutedUsers = useVoiceStore((s) => s.localMutedUsers);
  const toggleLocalMute = useVoiceStore((s) => s.toggleLocalMute);
  const voiceStates = useVoiceStore((s) => s.voiceStates);

  // Admin permission kontrolü
  const currentUser = useAuthStore((s) => s.user);
  const members = useMemberStore((s) => s.members);
  const currentMember = members.find((m) => m.id === currentUser?.id);
  const isAdmin = currentMember
    ? hasPermission(currentMember.effective_permissions, Permissions.Admin)
    : false;

  // Hedef kullanıcının mevcut voice state'i
  const targetVoiceState = (() => {
    for (const states of Object.values(voiceStates)) {
      const found = states.find((s) => s.user_id === userId);
      if (found) return found;
    }
    return null;
  })();

  const isLocallyMuted = localMutedUsers[userId] ?? false;
  const currentVolume = userVolumes[userId] ?? 100;
  const isServerMuted = targetVoiceState?.is_server_muted ?? false;
  const isServerDeafened = targetVoiceState?.is_server_deafened ?? false;

  const name = displayName || username;

  // ─── Dış tıklama + Escape ile kapatma ───
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    // Bir frame bekle — sağ tık event'inin kendisi "click outside" algılanmasın
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    });

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // ─── Pozisyon düzeltme — ekranın dışına taşmayı önle ───
  useEffect(() => {
    if (!menuRef.current) return;

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let adjustedX = position.x;
    let adjustedY = position.y;

    if (adjustedX + rect.width > viewportW - 8) {
      adjustedX = viewportW - rect.width - 8;
    }
    if (adjustedY + rect.height > viewportH - 8) {
      adjustedY = viewportH - rect.height - 8;
    }

    menu.style.left = `${adjustedX}px`;
    menu.style.top = `${adjustedY}px`;
  }, [position]);

  // ─── Handlers ───

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setUserVolume(userId, Number(e.target.value));
    },
    [userId, setUserVolume]
  );

  const handleLocalMuteToggle = useCallback(() => {
    toggleLocalMute(userId);
  }, [userId, toggleLocalMute]);

  const handleServerMuteToggle = useCallback(() => {
    if (onAdminStateUpdate) {
      onAdminStateUpdate(userId, !isServerMuted, undefined);
    }
  }, [userId, isServerMuted, onAdminStateUpdate]);

  const handleServerDeafenToggle = useCallback(() => {
    if (onAdminStateUpdate) {
      onAdminStateUpdate(userId, undefined, !isServerDeafened);
    }
  }, [userId, isServerDeafened, onAdminStateUpdate]);

  return createPortal(
    <div
      ref={menuRef}
      className="voice-ctx-menu"
      style={{ left: position.x, top: position.y }}
    >
      {/* Header: Avatar + Name */}
      <div className="voice-ctx-header">
        <Avatar
          name={name}
          avatarUrl={avatarUrl || undefined}
          size={32}
          isCircle
        />
        <span className="voice-ctx-header-name">{name}</span>
      </div>

      <div className="voice-ctx-body">
        {/* Volume Slider */}
        <div className="voice-ctx-slider">
          <svg style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
          </svg>
          <input
            type="range"
            min={0}
            max={200}
            value={currentVolume}
            onChange={handleVolumeChange}
            className="voice-ctx-range"
            style={{
              background: `linear-gradient(to right, var(--primary) ${(currentVolume / 200) * 100}%, var(--bg-5) ${(currentVolume / 200) * 100}%)`,
            }}
          />
          <span className="voice-ctx-vol-value">{currentVolume}%</span>
        </div>

        <div className="voice-ctx-divider" />

        {/* Local Mute Toggle */}
        <button
          className={`voice-ctx-item${isLocallyMuted ? " active" : ""}`}
          onClick={handleLocalMuteToggle}
        >
          {/* Speaker off icon */}
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            {isLocallyMuted ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072" />
            )}
          </svg>
          {isLocallyMuted ? t("localUnmute") : t("localMute")}
        </button>

        {/* Admin Actions */}
        {isAdmin && (
          <>
            <div className="voice-ctx-divider" />

            {/* Server Mute */}
            <button
              className={`voice-ctx-item danger${isServerMuted ? " active" : ""}`}
              onClick={handleServerMuteToggle}
            >
              {/* Mic off icon */}
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M12 15a3 3 0 003-3V5a3 3 0 00-6 0v7a3 3 0 003 3z" />
                {isServerMuted && (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                )}
              </svg>
              {isServerMuted ? t("serverUnmute") : t("serverMute")}
            </button>

            {/* Server Deafen */}
            <button
              className={`voice-ctx-item danger${isServerDeafened ? " active" : ""}`}
              onClick={handleServerDeafenToggle}
            >
              {/* Headphone off icon */}
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 18v-6a9 9 0 0118 0v6M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
                {isServerDeafened && (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                )}
              </svg>
              {isServerDeafened ? t("serverUndeafen") : t("serverDeafen")}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

export default VoiceUserContextMenu;
