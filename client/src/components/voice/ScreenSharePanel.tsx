/**
 * ScreenSharePanel — Single screen share video panel.
 *
 * Renders a LiveKit VideoTrack with hover overlay (user name + fullscreen button),
 * Browser Fullscreen API support, and right-click context menu for independent
 * screen share audio volume control.
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { VideoTrack } from "@livekit/components-react";
import type { TrackReferenceOrPlaceholder, TrackReference } from "@livekit/components-react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useVoiceStore } from "../../stores/voiceStore";
import { resolveUserId } from "../../utils/constants";
import { useIsTouch } from "../../hooks/useMediaQuery";
import { useCinemaMode } from "../../hooks/useCinemaMode";
import ScreenShareContextMenu from "./ScreenShareContextMenu";
import CinemaButton from "../shared/CinemaButton";

type ScreenSharePanelProps = {
  trackRef: TrackReferenceOrPlaceholder;
};

function ScreenSharePanel({ trackRef }: ScreenSharePanelProps) {
  const { t } = useTranslation("voice");

  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const isTouch = useIsTouch();
  const { isCinema, enter: enterCinema, exit: exitCinema } = useCinemaMode(containerRef);

  // Stop-watching control auto-hides after 3s of no pointer movement so it
  // never covers the stream. Shown on entry/movement, hidden on leave/idle.
  const [controlsVisible, setControlsVisible] = useState(false);
  const idleTimerRef = useRef<number>(0);

  // ─── Focus (double-click) ───
  const focusScreenShare = useVoiceStore((s) => s.focusScreenShare);
  const toggleWatchScreenShare = useVoiceStore((s) => s.toggleWatchScreenShare);
  const watchingCount = useVoiceStore(
    (s) => Object.keys(s.watchingScreenShares).length
  );

  // ─── Context Menu State ───
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const currentUser = useAuthStore((s) => s.user);
  const realUserId = resolveUserId(trackRef.participant.identity);
  const isLocalUser = realUserId === currentUser?.id;

  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => setControlsVisible(false), 3000);
  }, []);

  const hideControls = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = 0;
    }
    setControlsVisible(false);
  }, []);

  useEffect(() => () => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
  }, []);

  const handleFullscreenToggle = useCallback(() => {
    if (!containerRef.current) return;

    if (document.fullscreenElement) {
      document.exitFullscreen().catch((err: unknown) => {
        console.error("[ScreenSharePanel] Failed to exit fullscreen:", err);
      });
    } else {
      containerRef.current.requestFullscreen().catch((err: unknown) => {
        console.error("[ScreenSharePanel] Failed to enter fullscreen:", err);
      });
    }
  }, []);

  const displayName = trackRef.participant.name || realUserId;

  // Double-click toggles fullscreen. When multiple streams are visible, also
  // focus this one so the fullscreen view is on the stream the user picked.
  // While fullscreen, double-click just exits (no focus change).
  const handleDoubleClick = useCallback(() => {
    if (!isFullscreen && watchingCount > 1) {
      focusScreenShare(realUserId);
    }
    handleFullscreenToggle();
  }, [isFullscreen, watchingCount, focusScreenShare, realUserId, handleFullscreenToggle]);

  // Always suppress the browser/native context menu on the video — even for
  // own stream where we don't open ours. Without this, fullscreen <video>
  // shows the browser's media menu (Save as…, Picture-in-Picture, etc.).
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (isLocalUser) return;
      setCtxMenu({ x: e.clientX, y: e.clientY });
    },
    [isLocalUser]
  );

  return (
    <div
      ref={containerRef}
      className={`screen-share-panel${isCinema ? " cinema" : ""}`}
      onContextMenu={handleContextMenu}
      onDoubleClick={handleDoubleClick}
      onMouseEnter={showControls}
      onMouseMove={showControls}
      onMouseLeave={hideControls}
    >
      {/* Narrow TrackReferenceOrPlaceholder to TrackReference when publication exists */}
      {trackRef.publication && (
        <VideoTrack trackRef={trackRef as TrackReference} />
      )}


      {/* Stop-watching — centered bottom, hidden when pointer is idle so it
          doesn't obscure the stream. Not shown on your own shared screen. */}
      {!isLocalUser && (
        <button
          onClick={() => toggleWatchScreenShare(realUserId)}
          className={`screen-share-stop-btn${controlsVisible ? " visible" : ""}`}
          title={t("stopWatching")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {t("stopWatching")}
        </button>
      )}

      {/* Hover overlay with CSS opacity transition. The buttons live in a flex stack so the
          browser decides the gap between them — an offset computed from the other button's
          height is a collision waiting for a device we do not own. */}
      <div className="screen-share-panel-overlay">
        <span className="screen-share-panel-label">{displayName}</span>

        <div className="media-controls">
        <button
          onClick={handleFullscreenToggle}
          className="screen-share-panel-btn"
          title={isFullscreen ? t("exitFullscreen") : t("fullscreen")}
        >
          {isFullscreen ? (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
            </svg>
          ) : (
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
            </svg>
          )}
        </button>

        {isTouch && (
          <CinemaButton isCinema={isCinema} onEnter={enterCinema} onExit={exitCinema} />
        )}
        </div>
      </div>

      {ctxMenu && (
        <ScreenShareContextMenu
          userId={realUserId}
          displayName={displayName}
          position={ctxMenu}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

export default ScreenSharePanel;
