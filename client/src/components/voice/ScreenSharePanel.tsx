/**
 * ScreenSharePanel — Tek bir ekran paylaşımı video paneli.
 *
 * Sorumlulukları:
 * 1. LiveKit VideoTrack'i render eder (h-full w-full object-contain)
 * 2. Hover'da overlay gösterir (opacity transition):
 *    - Sol alt: Paylaşan kullanıcının ismi
 *    - Sağ alt: Fullscreen butonu
 * 3. Browser Fullscreen API ile tam ekran modu
 *
 * Fullscreen API nasıl çalışır?
 * element.requestFullscreen(): Elementi tam ekran yapar
 * document.exitFullscreen(): Tam ekrandan çıkar
 * document.fullscreenElement: Şu an tam ekranda olan element (null ise değil)
 * fullscreenchange event: Durum değiştiğinde tetiklenir — buton ikonunu günceller
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { VideoTrack } from "@livekit/components-react";
import type { TrackReferenceOrPlaceholder } from "@livekit/components-react";
import { useTranslation } from "react-i18next";

type ScreenSharePanelProps = {
  trackRef: TrackReferenceOrPlaceholder;
};

function ScreenSharePanel({ trackRef }: ScreenSharePanelProps) {
  const { t } = useTranslation("voice");

  // Panel container ref — fullscreen API bu element üzerinde çalışır
  const containerRef = useRef<HTMLDivElement>(null);

  // Fullscreen durumu — buton ikonunu belirler
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Fullscreen durum değişikliğini dinle
  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  // Fullscreen toggle
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

  const displayName = trackRef.participant.name || trackRef.participant.identity;

  return (
    <div
      ref={containerRef}
      className="group relative h-full w-full overflow-hidden rounded-lg bg-background-secondary"
    >
      {/* Screen share video — aspect ratio korunarak container'ı doldurur */}
      <VideoTrack
        trackRef={trackRef}
        className="h-full w-full object-contain"
      />

      {/* Hover overlay — opacity 0 → hover'da opacity 100 (transition ile) */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        {/* Sol alt: Paylaşan kullanıcı ismi */}
        <div className="pointer-events-auto absolute bottom-2 left-2 rounded bg-background-floating/80 px-2 py-0.5">
          <span className="text-xs font-medium text-text-primary">
            {displayName}
          </span>
        </div>

        {/* Sağ alt: Fullscreen butonu */}
        <button
          onClick={handleFullscreenToggle}
          className="pointer-events-auto absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded bg-background-floating/80 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          title={isFullscreen ? t("exitFullscreen") : t("fullscreen")}
        >
          {isFullscreen ? (
            // Exit fullscreen icon — küçült
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
            </svg>
          ) : (
            // Enter fullscreen icon — büyüt
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

export default ScreenSharePanel;
