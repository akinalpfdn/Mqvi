/**
 * ScreenSharePanel — Tek bir ekran paylaşımı video paneli.
 *
 * CSS class'ları: .screen-share-panel, .screen-share-panel-overlay,
 * .screen-share-panel-label, .screen-share-panel-btn
 *
 * Sorumlulukları:
 * 1. LiveKit VideoTrack'i render eder (object-contain)
 * 2. Hover'da overlay gösterir (opacity transition):
 *    - Sol alt: Paylaşan kullanıcının ismi
 *    - Sağ alt: Fullscreen butonu
 * 3. Browser Fullscreen API ile tam ekran modu
 * 4. Sağ tık context menu: ScreenShareContextMenu (bağımsız screen share audio volume)
 *
 * Fullscreen API nasıl çalışır?
 * element.requestFullscreen(): Elementi tam ekran yapar
 * document.exitFullscreen(): Tam ekrandan çıkar
 * document.fullscreenElement: Şu an tam ekranda olan element (null ise değil)
 * fullscreenchange event: Durum değiştiğinde tetiklenir — buton ikonunu günceller
 */

import { useRef, useState, useEffect, useCallback } from "react";
import { VideoTrack } from "@livekit/components-react";
import type { TrackReferenceOrPlaceholder, TrackReference } from "@livekit/components-react";
import { useTranslation } from "react-i18next";
import { useAuthStore } from "../../stores/authStore";
import { useVoiceStore } from "../../stores/voiceStore";
import ScreenShareContextMenu from "./ScreenShareContextMenu";

type ScreenSharePanelProps = {
  trackRef: TrackReferenceOrPlaceholder;
};

function ScreenSharePanel({ trackRef }: ScreenSharePanelProps) {
  const { t } = useTranslation("voice");

  // Panel container ref — fullscreen API bu element üzerinde çalışır
  const containerRef = useRef<HTMLDivElement>(null);

  // Fullscreen durumu — buton ikonunu belirler
  const [isFullscreen, setIsFullscreen] = useState(false);

  // ─── Focus (çift tıklama) ───
  const focusScreenShare = useVoiceStore((s) => s.focusScreenShare);
  const watchingCount = useVoiceStore(
    (s) => Object.keys(s.watchingScreenShares).length
  );

  // ─── Context Menu State ───
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const currentUser = useAuthStore((s) => s.user);
  const isLocalUser = trackRef.participant.identity === currentUser?.id;

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

  // Çift tıklama handler — birden fazla yayın izleniyorken tek birine odaklan.
  // Tek yayın izleniyorsa çift tıklama işlevsiz (zaten tek o var).
  const handleDoubleClick = useCallback(() => {
    if (watchingCount > 1) {
      focusScreenShare(trackRef.participant.identity);
    }
  }, [watchingCount, focusScreenShare, trackRef.participant.identity]);

  // Sağ tık handler — kendi screen share'imize context menu gösterme
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
      {/* Screen share video — aspect ratio korunarak container'ı doldurur */}
      {/* TrackReferenceOrPlaceholder → TrackReference narrowing: publication varsa gerçek track */}
      {trackRef.publication && (
        <VideoTrack trackRef={trackRef as TrackReference} />
      )}

      {/* Hover overlay — opacity 0 → hover'da opacity 1 (CSS transition ile) */}
      <div className="screen-share-panel-overlay">
        {/* Sol alt: Paylaşan kullanıcı ismi */}
        <span className="screen-share-panel-label">{displayName}</span>

        {/* Sağ alt: Fullscreen butonu */}
        <button
          onClick={handleFullscreenToggle}
          className="screen-share-panel-btn"
          title={isFullscreen ? t("exitFullscreen") : t("fullscreen")}
        >
          {isFullscreen ? (
            // Exit fullscreen icon — küçült
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
            </svg>
          ) : (
            // Enter fullscreen icon — büyüt
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
            </svg>
          )}
        </button>
      </div>

      {/* Sağ tık context menu — screen share audio bağımsız volume kontrolü */}
      {ctxMenu && (
        <ScreenShareContextMenu
          userId={trackRef.participant.identity}
          displayName={displayName}
          position={ctxMenu}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

export default ScreenSharePanel;
