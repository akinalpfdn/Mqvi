/**
 * ScreenShareView — Manages and renders active screen share tracks.
 *
 * Layout: 0 tracks = hidden, 1 = single panel, 2 = split view with resize handle,
 * 3+ = CSS grid. Split view supports vertical/horizontal toggle and draggable ratio.
 *
 * splitRatio and layoutMode are component-local state (not Zustand) because they
 * are transient UI state that should reset when screen shares change.
 */

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import ScreenSharePanel from "./ScreenSharePanel";
import ScreenShareResizeHandle from "./ScreenShareResizeHandle";

type LayoutMode = "vertical" | "horizontal";

/** Split ratio bounds — each panel gets at least 20% */
const MIN_RATIO = 20;
const MAX_RATIO = 80;
const DEFAULT_RATIO = 50;

function ScreenShareView() {
  const { t } = useTranslation("voice");

  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);

  // All screen share tracks (local + remote, no placeholders)
  const allScreenShareTracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: false }
  );

  // Filter to only tracks the user is watching
  const screenShareTracks = useMemo(
    () => allScreenShareTracks.filter(
      (t) => watchingScreenShares[t.participant.identity] ?? false
    ),
    [allScreenShareTracks, watchingScreenShares]
  );

  const [layoutMode, setLayoutMode] = useState<LayoutMode>("vertical");
  const [splitRatio, setSplitRatio] = useState(DEFAULT_RATIO);

  // Container ref for converting pixel deltas to percentages
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset ratio when dropping back to single track
  useEffect(() => {
    if (screenShareTracks.length < 2) {
      setSplitRatio(DEFAULT_RATIO);
    }
  }, [screenShareTracks.length]);

  // Convert pixel delta to percentage and clamp within bounds
  const handleResize = useCallback(
    (delta: number) => {
      if (!containerRef.current) return;

      const containerSize =
        layoutMode === "vertical"
          ? containerRef.current.clientHeight
          : containerRef.current.clientWidth;

      if (containerSize === 0) return;

      const deltaPercent = (delta / containerSize) * 100;
      setSplitRatio((prev) =>
        Math.max(MIN_RATIO, Math.min(MAX_RATIO, prev + deltaPercent))
      );
    },
    [layoutMode]
  );

  const handleToggleLayout = useCallback(() => {
    setLayoutMode((prev) => (prev === "vertical" ? "horizontal" : "vertical"));
  }, []);

  if (screenShareTracks.length === 0) return null;

  // Single track — full area
  if (screenShareTracks.length === 1) {
    return (
      <div className="screen-share-view">
        <ScreenSharePanel trackRef={screenShareTracks[0]} />
      </div>
    );
  }

  // Two tracks — split view with resize handle
  if (screenShareTracks.length === 2) {
    const isVertical = layoutMode === "vertical";
    const splitClass = `screen-share-split ${isVertical ? "vertical" : "horizontal"}`;

    return (
      <div className="screen-share-view">
        {/* Layout toggle — shows icon for the mode it will switch TO */}
        <button
          onClick={handleToggleLayout}
          className="screen-share-toggle"
          title={t("toggleLayout")}
        >
          {isVertical ? (
            <svg
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3v18M3.75 3h16.5a.75.75 0 01.75.75v16.5a.75.75 0 01-.75.75H3.75a.75.75 0 01-.75-.75V3.75A.75.75 0 013.75 3z"
              />
            </svg>
          ) : (
            <svg
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 12h18M3.75 3h16.5a.75.75 0 01.75.75v16.5a.75.75 0 01-.75.75H3.75a.75.75 0 01-.75-.75V3.75A.75.75 0 013.75 3z"
              />
            </svg>
          )}
        </button>

        {/* Split container — flex ratio determines panel sizes */}
        <div ref={containerRef} className={splitClass}>
          <div style={{ flex: splitRatio }} className="screen-share-pane">
            <ScreenSharePanel trackRef={screenShareTracks[0]} />
          </div>

          <ScreenShareResizeHandle
            direction={layoutMode}
            onResize={handleResize}
          />

          <div style={{ flex: 100 - splitRatio }} className="screen-share-pane">
            <ScreenSharePanel trackRef={screenShareTracks[1]} />
          </div>
        </div>
      </div>
    );
  }

  // 3+ tracks — equal-size CSS grid (2 columns, auto rows)
  return (
    <div className="screen-share-view">
      <div className="screen-share-grid">
        {screenShareTracks.map((trackRef) => (
          <div key={trackRef.participant.identity} className="screen-share-pane">
            <ScreenSharePanel trackRef={trackRef} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default ScreenShareView;
