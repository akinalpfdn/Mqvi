/**
 * StreamStatsOverlay — live numbers on a screen share, Steam-style.
 *
 * Its own component with its own state on purpose: the panel it sits in also renders the
 * <VideoTrack>, and re-rendering that once a second to move a frame counter would be the overlay
 * breaking the very stream it reports on.
 */

import { useTranslation } from "react-i18next";
import type { RemoteVideoTrack } from "livekit-client";
import { useReceiverStats } from "../../hooks/useReceiverStats";
import type { StreamStatsCorner } from "../../stores/slices/voiceSettingsSlice";

type StreamStatsOverlayProps = {
  track: RemoteVideoTrack | undefined;
  mode: "fps" | "stats";
  corner: StreamStatsCorner;
};

function StreamStatsOverlay({ track, mode, corner }: StreamStatsOverlayProps) {
  const { t } = useTranslation("voice");
  const sample = useReceiverStats(track);

  if (!sample) return null;

  const resolution = sample.width && sample.height ? `${sample.width}x${sample.height}` : null;

  return (
    <div className={`ss-stats ss-stats-${corner}`} aria-hidden="true">
      <span className="ss-stats-fps">{sample.fps} FPS</span>

      {mode === "stats" && (
        <>
          {/* The one number nobody can otherwise find out: the stream follows the source's own
              size under the quality cap, so a small window shares small. */}
          {resolution && <span className="ss-stats-line">{resolution}</span>}
          <span className="ss-stats-line">{sample.kbps} kbps</span>
          {sample.codec && (
            <span className="ss-stats-line">
              {sample.codec}
              {sample.decoder ? ` · ${sample.decoder}` : ""}
            </span>
          )}
          {sample.dropped > 0 && (
            <span className="ss-stats-line ss-stats-warn">
              {t("statsDropped", { count: sample.dropped })}
            </span>
          )}
        </>
      )}
    </div>
  );
}

export default StreamStatsOverlay;
