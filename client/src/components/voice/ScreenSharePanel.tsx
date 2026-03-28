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
import ScreenShareContextMenu from "./ScreenShareContextMenu";

type ScreenSharePanelProps = {
  trackRef: TrackReferenceOrPlaceholder;
};

function ScreenSharePanel({ trackRef }: ScreenSharePanelProps) {
  const { t } = useTranslation("voice");

  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ─── Focus (double-click) ───
  const focusScreenShare = useVoiceStore((s) => s.focusScreenShare);
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

  // Double-click to focus a single stream when multiple are visible
  const handleDoubleClick = useCallback(() => {
    if (watchingCount > 1) {
      focusScreenShare(realUserId);
    }
  }, [watchingCount, focusScreenShare, realUserId]);

  // Skip context menu for own screen share
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isLocalUser) return;
      e.preventDefault();
      setCtxMenu({ x: e.clientX, y: e.clientY });
    },
    [isLocalUser]
  );

  return (
    <div ref={containerRef} className="screen-share-panel" onContextMenu={handleContextMenu} onDoubleClick={handleDoubleClick}>
      {/* Narrow TrackReferenceOrPlaceholder to TrackReference when publication exists */}
      {trackRef.publication && (
        <VideoTrack trackRef={trackRef as TrackReference} />
      )}

      {/* Hover overlay with CSS opacity transition */}
      <div className="screen-share-panel-overlay">
        <span className="screen-share-panel-label">{displayName}</span>

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
