/**
 * UserBar — User info, voice controls, and status picker at the bottom of the sidebar.
 * Shows mic/deafen/screen/disconnect when in voice, status picker on avatar click.
 */

import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useChannelStore } from "../../stores/channelStore";
import { useServerStore } from "../../stores/serverStore";
import Avatar from "../shared/Avatar";
import MemberCard from "../members/MemberCard";
import AudioDevicePopup from "./AudioDevicePopup";
import { useSoundboardStore } from "../../stores/soundboardStore";
import SoundboardPanel from "../soundboard/SoundboardPanel";
import type { ScreenShareQuality } from "../../stores/voiceStore";
import { createPortal } from "react-dom";

type UserBarProps = {
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onDisconnect: () => void;
};

function UserBar({
  onToggleMute,
  onToggleDeafen,
  onToggleScreenShare,
  onDisconnect,
}: UserBarProps) {
  const { t } = useTranslation("voice");
  const { t: tc } = useTranslation("common");
  const user = useAuthStore((s) => s.user);
  const manualStatus = useAuthStore((s) => s.manualStatus);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const isStreaming = useVoiceStore((s) => s.isStreaming);
  const openSettings = useSettingsStore((s) => s.openSettings);

  const noiseReduction = useVoiceStore((s) => s.noiseReduction);
  const setNoiseReduction = useVoiceStore((s) => s.setNoiseReduction);
  const rtt = useVoiceStore((s) => s.rtt);
  const isInVoice = !!currentVoiceChannelId;
  const isPanelOpen = useSoundboardStore((s) => s.isPanelOpen);
  const togglePanel = useSoundboardStore((s) => s.togglePanel);
  const closePanel = useSoundboardStore((s) => s.closePanel);
  const sbRef = useRef<HTMLDivElement>(null);
  const sbBtnRef = useRef<HTMLButtonElement>(null);
  const [sbPos, setSbPos] = useState<{ top: number; left: number } | null>(null);

  // Audio device popup state
  const micChevronRef = useRef<HTMLButtonElement>(null);
  const speakerChevronRef = useRef<HTMLButtonElement>(null);
  const screenShareChevronRef = useRef<HTMLButtonElement>(null);
  const [devicePopup, setDevicePopup] = useState<"input" | "output" | "screenshare" | null>(null);

  // Connected voice channel name
  const categories = useChannelStore((s) => s.categories);
  const activeServer = useServerStore((s) => s.activeServer);
  const voiceChannelName = isInVoice
    ? categories.flatMap((cg) => cg.channels).find((ch) => ch.id === currentVoiceChannelId)?.name
    : undefined;

  // Own profile card state
  const userRowRef = useRef<HTMLDivElement>(null);
  const [ownCardPos, setOwnCardPos] = useState<{ top: number; left: number } | null>(null);

  // Ping color: green < 100ms, yellow 100-200ms, red > 200ms
  const pingColor = rtt <= 0 ? "" : rtt < 100 ? "ub-ping-good" : rtt < 200 ? "ub-ping-mid" : "ub-ping-bad";

  function openOwnCard() {
    if (!userRowRef.current) return;
    const rect = userRowRef.current.getBoundingClientRect();
    setOwnCardPos({ top: rect.top - 6, left: rect.left });
  }

  // Compute soundboard popup position from button rect
  useEffect(() => {
    if (!isPanelOpen || !sbBtnRef.current) return;
    const rect = sbBtnRef.current.getBoundingClientRect();
    setSbPos({ top: rect.top - 6, left: rect.left });
  }, [isPanelOpen]);

  // Close soundboard on click outside
  useEffect(() => {
    if (!isPanelOpen) return;
    function handleClick(e: MouseEvent) {
      if (sbRef.current && !sbRef.current.contains(e.target as Node)) {
        closePanel();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isPanelOpen, closePanel]);

  // Close soundboard on Escape
  useEffect(() => {
    if (!isPanelOpen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") closePanel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isPanelOpen, closePanel]);

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
            <span className="ub-voice-label">{t("voiceConnected")}</span>
            {rtt > 0 && (
              <div className="ub-ping-tooltip">
                <span className={`ub-ping-value ${pingColor}`}>{rtt} ms</span>
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
            <div className="ub-ctrl-group">
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
                ref={screenShareChevronRef}
                className={`ub-chevron${devicePopup === "screenshare" ? " active" : ""}`}
                onClick={() => setDevicePopup(devicePopup === "screenshare" ? null : "screenshare")}
              >
                <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor">
                  {devicePopup === "screenshare"
                    ? <path d="M2 7l3-4 3 4H2z" />
                    : <path d="M2 3l3 4 3-4H2z" />
                  }
                </svg>
              </button>
            </div>
            <button
              ref={sbBtnRef}
              className={`ub-ctrl${isPanelOpen ? " active" : ""}`}
              onClick={togglePanel}
              title={t("soundboard", { ns: "soundboard" })}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6zM10 19a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
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

      {/* User avatar + settings */}
      <div className="ub-main">
        <div
          ref={userRowRef}
          className="ub-user"
          onClick={openOwnCard}
          title={tc("userProfile")}
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
        </div>

        {/* Mic toggle + device chevron */}
        <div className="ub-ctrl-group">
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
            ref={micChevronRef}
            className={`ub-chevron${devicePopup === "input" ? " active" : ""}`}
            onClick={() => setDevicePopup(devicePopup === "input" ? null : "input")}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor">
              {devicePopup === "input"
                ? <path d="M2 7l3-4 3 4H2z" />
                : <path d="M2 3l3 4 3-4H2z" />
              }
            </svg>
          </button>
        </div>

        {/* Deafen toggle + device chevron */}
        <div className="ub-ctrl-group">
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
            ref={speakerChevronRef}
            className={`ub-chevron${devicePopup === "output" ? " active" : ""}`}
            onClick={() => setDevicePopup(devicePopup === "output" ? null : "output")}
          >
            <svg width="12" height="12" viewBox="0 0 10 10" fill="currentColor">
              {devicePopup === "output"
                ? <path d="M2 7l3-4 3 4H2z" />
                : <path d="M2 3l3 4 3-4H2z" />
              }
            </svg>
          </button>
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

      {/* Audio device popup */}
      {devicePopup === "input" && micChevronRef.current && (
        <AudioDevicePopup
          kind="input"
          anchorEl={micChevronRef.current}
          onClose={() => setDevicePopup(null)}
        />
      )}
      {devicePopup === "output" && speakerChevronRef.current && (
        <AudioDevicePopup
          kind="output"
          anchorEl={speakerChevronRef.current}
          onClose={() => setDevicePopup(null)}
        />
      )}

      {/* Screen share quality popup */}
      {devicePopup === "screenshare" && screenShareChevronRef.current && (
        <ScreenShareQualityPopup
          anchorEl={screenShareChevronRef.current}
          onClose={() => setDevicePopup(null)}
        />
      )}

      {/* Soundboard floating popup — fixed position, above button */}
      {isPanelOpen && sbPos && (
        <div
          ref={sbRef}
          className="sb-float-popup"
          style={{ top: sbPos.top, left: sbPos.left, transform: "translateY(-100%)" }}
        >
          <SoundboardPanel />
        </div>
      )}

      {/* Own profile card — status picker lives here */}
      {ownCardPos && (
        <MemberCard
          user={user}
          position={ownCardPos}
          onClose={() => setOwnCardPos(null)}
        />
      )}
    </div>
  );
}

/** Minimal popup for screen share quality selection. */
function ScreenShareQualityPopup({
  anchorEl,
  onClose,
}: {
  anchorEl: HTMLElement;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const quality = useVoiceStore((s) => s.screenShareQuality);
  const setQuality = useVoiceStore((s) => s.setScreenShareQuality);
  const popupRef = useRef<HTMLDivElement>(null);

  const rect = anchorEl.getBoundingClientRect();
  const top = rect.top - 6;
  const left = rect.left;

  const options: { value: ScreenShareQuality; label: string }[] = [
    { value: "720p", label: "720p 30fps" },
    { value: "1080p", label: "1080p 30fps" },
  ];

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    requestAnimationFrame(() => document.addEventListener("mousedown", handleClick));
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  return createPortal(
    <div
      ref={popupRef}
      className="adp-popup"
      style={{ top, left, transform: "translateY(-100%)" }}
    >
      <div className="adp-section">
        <div className="adp-label">{t("screenShareQuality")}</div>
        {options.map((opt) => (
          <button
            key={opt.value}
            className={`adp-submenu-item${quality === opt.value ? " selected" : ""}`}
            onClick={() => { setQuality(opt.value); onClose(); }}
          >
            <span className="adp-submenu-label">{opt.label}</span>
            {quality === opt.value && <div className="adp-submenu-check" />}
          </button>
        ))}
      </div>
    </div>,
    document.body
  );
}

export default UserBar;
