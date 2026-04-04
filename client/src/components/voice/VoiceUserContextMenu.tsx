/**
 * VoiceUserContextMenu — Right-click menu for voice sidebar users.
 * Rendered via portal to document.body to escape sidebar overflow:hidden.
 */

import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { useAuthStore } from "../../stores/authStore";
import { useActiveMembers } from "../../stores/memberStore";
import { useChannelStore } from "../../stores/channelStore";
import { useChannelPermissionStore } from "../../stores/channelPermissionStore";
import { hasPermission, Permissions, resolveChannelPermissions } from "../../utils/permissions";
import Avatar from "../shared/Avatar";

type VoiceUserContextMenuProps = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  position: { x: number; y: number };
  onClose: () => void;
};

function VoiceUserContextMenu({
  userId,
  username,
  displayName,
  avatarUrl,
  position,
  onClose,
}: VoiceUserContextMenuProps) {
  const { t } = useTranslation("voice");
  const menuRef = useRef<HTMLDivElement>(null);

  const userVolumes = useVoiceStore((s) => s.userVolumes);
  const setUserVolume = useVoiceStore((s) => s.setUserVolume);
  const localMutedUsers = useVoiceStore((s) => s.localMutedUsers);
  const toggleLocalMute = useVoiceStore((s) => s.toggleLocalMute);
  const voiceStates = useVoiceStore((s) => s.voiceStates);
  const wsSend = useVoiceStore((s) => s._wsSend);

  // Channel-level permission resolution
  const currentUser = useAuthStore((s) => s.user);
  const members = useActiveMembers();
  const categories = useChannelStore((s) => s.categories);
  const getOverrides = useChannelPermissionStore((s) => s.getOverrides);

  const currentMember = members.find((m) => m.id === currentUser?.id);
  const basePerms = currentMember?.effective_permissions ?? 0;
  const roleIds = useMemo(
    () => currentMember?.roles.map((r) => r.id) ?? [],
    [currentMember]
  );

  // Target user's current voice state
  const targetVoiceState = useMemo(() => {
    for (const states of Object.values(voiceStates)) {
      const found = states.find((s) => s.user_id === userId);
      if (found) return found;
    }
    return null;
  }, [voiceStates, userId]);

  const targetChannelId = targetVoiceState?.channel_id ?? "";
  const channelOverrides = getOverrides(targetChannelId);

  // Channel-level effective permissions (Discord algorithm)
  const channelPerms = useMemo(
    () => resolveChannelPermissions(basePerms, roleIds, channelOverrides),
    [basePerms, roleIds, channelOverrides]
  );

  const canMuteMembers = hasPermission(channelPerms, Permissions.MuteMembers);
  const canDeafenMembers = hasPermission(channelPerms, Permissions.DeafenMembers);
  const canMoveMembers = hasPermission(channelPerms, Permissions.MoveMembers);

  const hasAnyModPerm = canMuteMembers || canDeafenMembers || canMoveMembers;

  // Voice channels for "Move to Channel" (exclude target's current channel)
  const voiceChannels = useMemo(() => {
    return categories
      .flatMap((cg) => cg.channels)
      .filter((ch) => ch.type === "voice" && ch.id !== targetChannelId);
  }, [categories, targetChannelId]);

  const [showMoveMenu, setShowMoveMenu] = useState(false);

  const isLocallyMuted = localMutedUsers[userId] ?? false;
  const currentVolume = userVolumes[userId] ?? 100;
  const [preMuteVolume, setPreMuteVolume] = useState(currentVolume || 100);
  const isServerMuted = targetVoiceState?.is_server_muted ?? false;
  const isServerDeafened = targetVoiceState?.is_server_deafened ?? false;

  const name = displayName || username;

  // Close on outside click or Escape
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }

    // Delay one frame so the right-click event itself isn't caught as "outside click"
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscape);
    });

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  // Clamp position to viewport bounds
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

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = Number(e.target.value);
      if (val > 0) setPreMuteVolume(val);
      setUserVolume(userId, val);
    },
    [userId, setUserVolume]
  );

  const handleToggleMute = useCallback(() => {
    if (currentVolume > 0) {
      setPreMuteVolume(currentVolume);
      setUserVolume(userId, 0);
    } else {
      setUserVolume(userId, preMuteVolume);
    }
  }, [userId, currentVolume, preMuteVolume, setUserVolume]);

  const handleLocalMuteToggle = useCallback(() => {
    toggleLocalMute(userId);
  }, [userId, toggleLocalMute]);

  const handleServerMuteToggle = useCallback(() => {
    wsSend?.("voice_admin_state_update", {
      target_user_id: userId,
      is_server_muted: !isServerMuted,
    });
  }, [userId, isServerMuted, wsSend]);

  const handleServerDeafenToggle = useCallback(() => {
    wsSend?.("voice_admin_state_update", {
      target_user_id: userId,
      is_server_deafened: !isServerDeafened,
    });
  }, [userId, isServerDeafened, wsSend]);

  const handleDisconnect = useCallback(() => {
    wsSend?.("voice_disconnect_user", { target_user_id: userId });
    onClose();
  }, [userId, wsSend, onClose]);

  const handleMoveToChannel = useCallback(
    (targetChId: string) => {
      wsSend?.("voice_move_user", {
        target_user_id: userId,
        target_channel_id: targetChId,
      });
      onClose();
    },
    [userId, wsSend, onClose]
  );

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
          <svg
            style={{ width: 14, height: 14, cursor: "pointer", opacity: currentVolume === 0 ? 0.5 : 1 }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            onClick={handleToggleMute}
            title={currentVolume > 0 ? t("mute") : t("unmute")}
          >
            {currentVolume > 0 ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15zM17 9l-6 6M11 9l6 6" />
            )}
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

        {/* Moderation Actions — channel-level granular permission checks */}
        {hasAnyModPerm && (
          <>
            <div className="voice-ctx-divider" />

            {canMuteMembers && (
              <button
                className={`voice-ctx-item danger${isServerMuted ? " active" : ""}`}
                onClick={handleServerMuteToggle}
              >
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M12 15a3 3 0 003-3V5a3 3 0 00-6 0v7a3 3 0 003 3z" />
                  {isServerMuted && (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                  )}
                </svg>
                {isServerMuted ? t("serverUnmute") : t("serverMute")}
              </button>
            )}

            {canDeafenMembers && (
              <button
                className={`voice-ctx-item danger${isServerDeafened ? " active" : ""}`}
                onClick={handleServerDeafenToggle}
              >
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 18v-6a9 9 0 0118 0v6M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z" />
                  {isServerDeafened && (
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                  )}
                </svg>
                {isServerDeafened ? t("serverUndeafen") : t("serverDeafen")}
              </button>
            )}

            {canMoveMembers && (
              <button
                className="voice-ctx-item danger"
                onClick={handleDisconnect}
              >
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636a9 9 0 010 12.728M5.636 18.364a9 9 0 010-12.728" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
                </svg>
                {t("disconnectFromVoice")}
              </button>
            )}

            {canMoveMembers && voiceChannels.length > 0 && (
              <div className="voice-ctx-move-wrap">
                <button
                  className="voice-ctx-item"
                  onClick={() => setShowMoveMenu(!showMoveMenu)}
                >
                  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                  {t("moveToChannel")}
                  <svg
                    className="voice-ctx-chevron"
                    style={{ marginLeft: "auto", width: 14, height: 14, transform: showMoveMenu ? "rotate(90deg)" : "rotate(0deg)" }}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
                {showMoveMenu && (
                  <div className="voice-ctx-move-list">
                    {voiceChannels.map((ch) => (
                      <button
                        key={ch.id}
                        className="voice-ctx-move-item"
                        onClick={() => handleMoveToChannel(ch.id)}
                      >
                        <svg style={{ width: 14, height: 14, flexShrink: 0 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                        </svg>
                        <span className="voice-ctx-move-name">{ch.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

export default VoiceUserContextMenu;
