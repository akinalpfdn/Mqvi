/**
 * UserBar — User info, voice controls, and status picker at the bottom of the sidebar.
 * Shows mic/deafen/screen/disconnect when in voice, status picker on avatar click.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import Avatar from "../shared/Avatar";
import type { UserStatus } from "../../types";

const STATUS_OPTIONS: {
  value: UserStatus;
  labelKey: string;
  descKey: string;
  colorClass: string;
}[] = [
  { value: "online", labelKey: "online", descKey: "onlineDesc", colorClass: "ub-sp-green" },
  { value: "idle", labelKey: "idle", descKey: "idleDesc", colorClass: "ub-sp-yellow" },
  { value: "dnd", labelKey: "dnd", descKey: "dndDesc", colorClass: "ub-sp-red" },
  { value: "offline", labelKey: "invisible", descKey: "invisibleDesc", colorClass: "ub-sp-gray" },
];

type UserBarProps = {
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onDisconnect: () => void;
  sendPresenceUpdate: (status: UserStatus) => void;
};

function UserBar({
  onToggleMute,
  onToggleDeafen,
  onToggleScreenShare,
  onDisconnect,
  sendPresenceUpdate,
}: UserBarProps) {
  const { t } = useTranslation("voice");
  const { t: tc } = useTranslation("common");
  const user = useAuthStore((s) => s.user);
  const manualStatus = useAuthStore((s) => s.manualStatus);
  const setManualStatus = useAuthStore((s) => s.setManualStatus);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const openSettings = useSettingsStore((s) => s.openSettings);

  const noiseReduction = useVoiceStore((s) => s.noiseReduction);
  const setNoiseReduction = useVoiceStore((s) => s.setNoiseReduction);
  const rtt = useVoiceStore((s) => s.rtt);
  const isInVoice = !!currentVoiceChannelId;

  // Connected voice channel name
  const categories = useChannelStore((s) => s.categories);
  const activeServer = useServerStore((s) => s.activeServer);
  const voiceChannelName = isInVoice
    ? categories.flatMap((cg) => cg.channels).find((ch) => ch.id === currentVoiceChannelId)?.name
    : undefined;

  // Status picker popup state
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Ping color: green < 100ms, yellow 100-200ms, red > 200ms
  const pingColor = rtt <= 0 ? "" : rtt < 100 ? "ub-ping-good" : rtt < 200 ? "ub-ping-mid" : "ub-ping-bad";

  const handleStatusSelect = useCallback(
    (status: UserStatus) => {
      setManualStatus(status);
      sendPresenceUpdate(status);
      setIsPickerOpen(false);
    },
    [setManualStatus, sendPresenceUpdate],
  );

  // Close picker on click-outside
  useEffect(() => {
    if (!isPickerOpen) return;

    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setIsPickerOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isPickerOpen]);

  // Close picker on Escape
  useEffect(() => {
    if (!isPickerOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setIsPickerOpen(false);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isPickerOpen]);

  // Status dot color based on manual status preference
  const statusDotClass =
    manualStatus === "online"
      ? "ub-dot-online"
      : manualStatus === "idle"
        ? "ub-dot-idle"
        : manualStatus === "dnd"
          ? "ub-dot-dnd"
          : "ub-dot-offline";

  if (!user) return null;

  return (
    <div className="user-bar">
      {/* Voice controls row — shown above user info when connected */}
      {isInVoice && (
        <div className="ub-voice-row">
          <div className="ub-voice-info">
            <span className="ub-voice-pulse" />
            <span className="ub-voice-label">{t("voiceConnected")}</span>
            {/* Ping tooltip */}
            {rtt > 0 && (
              <div className="ub-ping-tooltip">
                <div className={`ub-ping-dot ${pingColor}`} />
                <span className="ub-ping-value">{rtt} ms</span>
              </div>
            )}
          </div>
          {/* Connected server / channel name */}
          {voiceChannelName && (
            <div className="ub-voice-channel">
              {activeServer ? `${activeServer.name} / ` : ""}{voiceChannelName}
            </div>
          )}
          {/* Noise Reduction toggle */}
          <div className="ub-nr-row">
            <div className="ub-nr-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 19V6l12-3v13M9 19c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2zM21 16c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2z" />
              </svg>
              <span>{t("noiseReduction")}</span>
            </div>
            <button
              className={`ub-switch${noiseReduction ? " active" : ""}`}
              onClick={() => setNoiseReduction(!noiseReduction)}
              title={noiseReduction ? t("noiseReductionOff") : t("noiseReductionOn")}
              role="switch"
              aria-checked={noiseReduction}
            >
              <span className="ub-switch-thumb" />
            </button>
          </div>
          <div className="ub-voice-btns">
            <button
              className={`ub-ctrl${isMuted ? " active" : ""}`}
              onClick={onToggleMute}
              title={isMuted ? t("unmute") : t("mute")}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                {isMuted ? (
                  <path d="M12 1a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4zM2.7 2.7a1 1 0 0 1 1.4 0l17 17a1 1 0 0 1-1.4 1.4L2.7 4.1a1 1 0 0 1 0-1.4zM6 10a1 1 0 0 0-2 0 8 8 0 0 0 7 7.9V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-3.1A8 8 0 0 0 20 10a1 1 0 1 0-2 0 6 6 0 0 1-9.7 4.7" />
                ) : (
                  <path d="M12 1a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V5a4 4 0 0 0-4-4zM6 10a1 1 0 0 0-2 0 8 8 0 0 0 7 7.9V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-3.1A8 8 0 0 0 20 10a1 1 0 1 0-2 0 6 6 0 0 1-12 0z" />
                )}
              </svg>
            </button>
            <button
              className={`ub-ctrl${isDeafened ? " active" : ""}`}
              onClick={onToggleDeafen}
              title={isDeafened ? t("undeafen") : t("deafen")}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                {isDeafened ? (
                  <path d="M3 12a9 9 0 0 1 18 0v5a4 4 0 0 1-4 4h-1a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h3v-1a7 7 0 0 0-14 0v1h3a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7a4 4 0 0 1-4-4v-5zM2.7 2.7a1 1 0 0 1 1.4 0l17 17a1 1 0 0 1-1.4 1.4L2.7 4.1a1 1 0 0 1 0-1.4z" />
                ) : (
                  <path d="M3 12a9 9 0 0 1 18 0v5a4 4 0 0 1-4 4h-1a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h3v-1a7 7 0 0 0-14 0v1h3a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7a4 4 0 0 1-4-4v-5z" />
                )}
              </svg>
            </button>
            <button
              className={`ub-ctrl${isStreaming ? " active" : ""}`}
              onClick={onToggleScreenShare}
              title={isStreaming ? t("stopScreenShare") : t("screenShare")}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6v2H7a1 1 0 1 0 0 2h10a1 1 0 1 0 0-2h-2v-2h6a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H3zm9 4a1 1 0 0 1 1 1v2h2a1 1 0 1 1 0 2h-2v2a1 1 0 1 1-2 0v-2H9a1 1 0 1 1 0-2h2V9a1 1 0 0 1 1-1z" />
              </svg>
            </button>
            <button
              className="ub-ctrl ub-end"
              onClick={onDisconnect}
              title={t("endCall")}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 8c-3.5 0-6.6 1.1-9 3a1 1 0 0 0 0 1.4l2.5 2.5a1 1 0 0 0 1.2.1c.8-.5 1.7-.9 2.7-1.1a1 1 0 0 0 .8-1v-2.8c.6-.1 1.2-.1 1.8-.1s1.2 0 1.8.1v2.8a1 1 0 0 0 .8 1c1 .2 1.9.6 2.7 1.1a1 1 0 0 0 1.2-.1L21 12.4a1 1 0 0 0 0-1.4c-2.4-1.9-5.5-3-9-3z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* User info + settings */}
      <div className="ub-main">
        <div className="ub-user-wrap" ref={pickerRef}>
          <div
            className="ub-user"
            onClick={() => setIsPickerOpen((prev) => !prev)}
            title={tc("setStatus")}
          >
            <div className="ub-avatar-wrap">
              <Avatar
                name={user.display_name || user.username}
                avatarUrl={user.avatar_url}
                size={32}
                isCircle
              />
              <span className={`ub-status-dot ${statusDotClass}`} />
            </div>
            <div className="ub-info">
              <span className="ub-name">{user.display_name || user.username}</span>
              <span className="ub-status">#{user.username}</span>
            </div>
          </div>

          {/* Status picker popup */}
          {isPickerOpen && (
            <div className="ub-sp">
              <div className="ub-sp-header">{tc("setStatus")}</div>
              <div className="ub-sp-divider" />
              {STATUS_OPTIONS.map((opt) => {
                const isActive = manualStatus === opt.value;
                return (
                  <button
                    key={opt.value}
                    className={`ub-sp-item${isActive ? " active" : ""}`}
                    onClick={() => handleStatusSelect(opt.value)}
                  >
                    <span className={`ub-sp-dot ${opt.colorClass}`} />
                    <div className="ub-sp-text">
                      <span className="ub-sp-label">{tc(opt.labelKey)}</span>
                      <span className="ub-sp-desc">{tc(opt.descKey)}</span>
                    </div>
                    {isActive && (
                      <svg className="ub-sp-check" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Settings button */}
        <button
          className="ub-ctrl ub-settings"
          onClick={() => openSettings("profile")}
          title={tc("settings")}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.3-3.7a1.5 1.5 0 0 1 .3 1.7l-.9 1.5a1.5 1.5 0 0 1-1.6.7l-1.1-.2a7 7 0 0 1-1.2.7l-.3 1.1a1.5 1.5 0 0 1-1.4 1h-1.8a1.5 1.5 0 0 1-1.4-1l-.3-1.1a7 7 0 0 1-1.2-.7l-1.1.2a1.5 1.5 0 0 1-1.6-.7l-.9-1.5a1.5 1.5 0 0 1 .3-1.7l.8-.9V10a7 7 0 0 1 0-1.4l-.8-.9a1.5 1.5 0 0 1-.3-1.7l.9-1.5a1.5 1.5 0 0 1 1.6-.7l1.1.2a7 7 0 0 1 1.2-.7l.3-1.1a1.5 1.5 0 0 1 1.4-1h1.8a1.5 1.5 0 0 1 1.4 1l.3 1.1a7 7 0 0 1 1.2.7l1.1-.2a1.5 1.5 0 0 1 1.6.7l.9 1.5a1.5 1.5 0 0 1-.3 1.7l-.8.9a7 7 0 0 1 0 1.4l.8.9z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default UserBar;
