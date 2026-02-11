/**
 * ScreenShareView — Aktif ekran paylaşımı track'lerini video olarak render eder.
 *
 * LiveKit'in useRemoteParticipants ve useTracks hook'larını kullanarak
 * aktif screen_share track'lerini bulur ve her birini video element'inde gösterir.
 *
 * Track nedir?
 * LiveKit'te her medya akışı (ses, kamera, ekran paylaşımı) bir "track"tir.
 * Track.Source.ScreenShare: Ekran paylaşımı video track'i.
 * VideoTrack component'i: Track'i <video> element'ine bind eder.
 *
 * CLAUDE.md kuralı: Max 2 concurrent screen share (server-side enforce).
 * Client tarafında da gösterimi buna göre düzenliyoruz.
 */

import { useTracks, VideoTrack } from "@livekit/components-react";
import { Track } from "livekit-client";

function ScreenShareView() {
  // Aktif screen share track'lerini al
  const screenShareTracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: true }
  );

  if (screenShareTracks.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 p-2">
      {screenShareTracks.map((trackRef) => (
        <div
          key={trackRef.participant.identity + "-screen"}
          className="relative overflow-hidden rounded-lg bg-background-secondary"
        >
          {/* Screen share video */}
          <VideoTrack
            trackRef={trackRef}
            className="h-auto max-h-[50vh] w-full object-contain"
          />

          {/* Paylaşan kullanıcının ismi */}
          <div className="absolute bottom-2 left-2 rounded bg-background-floating/80 px-2 py-0.5">
            <span className="text-xs font-medium text-text-primary">
              {trackRef.participant.name || trackRef.participant.identity}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default ScreenShareView;
