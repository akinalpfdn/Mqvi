/**
 * ScreenShareContextMenu — Independent volume control for screen share audio.
 *
 * Right-click on a screen share panel to open. Controls only the screen share
 * audio track — does not affect the user's mic volume (separate screenShareVolumes state).
 * Rendered via portal to escape panel overflow:hidden.
 */

import { useEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import { shareEngine } from "../../utils/constants";
import type { TrackReferenceOrPlaceholder } from "@livekit/components-react";
import type { StreamStatsCorner, StreamStatsMode } from "../../stores/slices/voiceSettingsSlice";

const STATS_MODES: StreamStatsMode[] = ["none", "fps", "stats"];
const CORNERS: StreamStatsCorner[] = ["tl", "tr", "bl", "br"];

type ScreenShareContextMenuProps = {
  userId: string;
  displayName: string;
  /** The share this menu belongs to — read for the info line, never modified. */
  trackRef: TrackReferenceOrPlaceholder;
  position: { x: number; y: number };
  onClose: () => void;
};

function ScreenShareContextMenu({
  userId,
  displayName,
  trackRef,
  position,
  onClose,
}: ScreenShareContextMenuProps) {
  const { t } = useTranslation("voice");
  const menuRef = useRef<HTMLDivElement>(null);

  const screenShareVolumes = useVoiceStore((s) => s.screenShareVolumes);
  const setScreenShareVolume = useVoiceStore((s) => s.setScreenShareVolume);
  const currentVolume = screenShareVolumes[userId] ?? 100;
  const [preMuteVolume, setPreMuteVolume] = useState(currentVolume || 100);

  const engine = trackRef.publication
    ? shareEngine(trackRef.publication.trackName, trackRef.participant.identity)
    : null;

  // The ceiling the sharer chose, from their voice state — "what they asked for", next to the
  // "what's coming" the live numbers show. voiceStates is grouped by channel, so scan the values.
  const shareQuality = useVoiceStore((s) => {
    for (const list of Object.values(s.voiceStates)) {
      const found = list.find((v) => v.user_id === userId);
      if (found?.share_quality) return found.share_quality;
    }
    return undefined;
  });

  // Global, not per-panel: in a split view both overlays belong in the same corner.
  const statsMode = useVoiceStore((s) => s.streamStatsMode);
  const setStatsMode = useVoiceStore((s) => s.setStreamStatsMode);
  const statsCorner = useVoiceStore((s) => s.streamStatsCorner);
  const setStatsCorner = useVoiceStore((s) => s.setStreamStatsCorner);

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

    // Delay one frame so the opening right-click doesn't trigger "click outside"
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
      setScreenShareVolume(userId, val);
    },
    [userId, setScreenShareVolume]
  );

  const handleToggleMute = useCallback(() => {
    if (currentVolume > 0) {
      setPreMuteVolume(currentVolume);
      setScreenShareVolume(userId, 0);
    } else {
      setScreenShareVolume(userId, preMuteVolume);
    }
  }, [userId, currentVolume, preMuteVolume, setScreenShareVolume]);

  return createPortal(
    <div
      ref={menuRef}
      className="voice-ctx-menu"
      style={{ left: position.x, top: position.y }}
    >
      {/* Header: Monitor icon + Name */}
      <div className="voice-ctx-header">
        <svg
          style={{ width: 32, height: 32, flexShrink: 0 }}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z"
          />
        </svg>
        <span className="voice-ctx-header-name">{displayName}</span>
      </div>

      <div className="voice-ctx-body">
        {/* What this stream actually is — the resolution especially, which follows the shared
            window's own size under the quality cap and is otherwise unknowable. */}
        {(shareQuality || engine) && (
          <div className="voice-ctx-info">
            {shareQuality ? t("shareQualityValue", { quality: shareQuality }) : ""}
            {shareQuality && engine ? " · " : ""}
            {engine ? t(`shareEngine_${engine}`) : ""}
          </div>
        )}

        <div className="voice-ctx-label">{t("screenShareVolume")}</div>

        <div className="voice-ctx-slider">
          <svg
            style={{ width: 14, height: 14, cursor: "pointer", opacity: currentVolume === 0 ? 0.5 : 1 }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            onClick={handleToggleMute}
          >
            {currentVolume > 0 ? (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.536 8.464a5 5 0 010 7.072M17.95 6.05a8 8 0 010 11.9M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"
              />
            ) : (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15zM17 9l-6 6M11 9l6 6"
              />
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

        <div className="voice-ctx-sep" />

        <div className="voice-ctx-label">{t("streamStats")}</div>

        <div className="voice-ctx-seg">
          {STATS_MODES.map((m) => (
            <button
              key={m}
              className={`voice-ctx-seg-opt${statsMode === m ? " active" : ""}`}
              onClick={() => setStatsMode(m)}
            >
              {t(`streamStats_${m}`)}
            </button>
          ))}
        </div>

        {/* Only worth showing once there is something to place. */}
        {statsMode !== "none" && (
          <div className="voice-ctx-corners" title={t("streamStatsCorner")}>
            {CORNERS.map((c) => (
              <button
                key={c}
                className={`voice-ctx-corner voice-ctx-corner-${c}${statsCorner === c ? " active" : ""}`}
                onClick={() => setStatsCorner(c)}
                aria-label={t(`streamStatsCorner_${c}`)}
                title={t(`streamStatsCorner_${c}`)}
              >
                <span />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    // In fullscreen mode only the fullscreen element's subtree is visible;
    // portal to it so the menu shows up. Falls back to body otherwise.
    document.fullscreenElement ?? document.body
  );
}

export default ScreenShareContextMenu;
