/**
 * ScreenShareView — Aktif ekran paylaşımı track'lerini yönetir ve render eder.
 *
 * CSS class'ları: .screen-share-view, .screen-share-split, .screen-share-split.vertical,
 * .screen-share-split.horizontal, .screen-share-pane, .screen-share-toggle
 *
 * Layout stratejisi:
 * - 0 track: null döner (gizlenir)
 * - 1 track: Tek ScreenSharePanel, flex-1 ile tüm alanı kaplar
 * - 2 track: Split view — ScreenSharePanel'ler arası ResizeHandle ile
 *
 * Split view özellikleri:
 * - layoutMode: "vertical" (alt alta, varsayılan) veya "horizontal" (yan yana)
 * - splitRatio: 20-80 arası yüzde, ResizeHandle sürüklenerek ayarlanır
 * - Layout toggle butonu: Sağ üst köşede, layoutMode'u değiştirir
 *
 * State neden component-local (Zustand'da değil)?
 * splitRatio ve layoutMode geçici UI state'leridir — sayfa yenilenmesinde
 * veya screen share kapanıp açıldığında sıfırlanması doğru davranıştır.
 * Zustand sadece persist edilmesi gereken veya cross-component paylaşılan
 * state için kullanılır.
 *
 * Flex ile boyutlandırma nasıl çalışır?
 * style={{ flex: splitRatio }} → flex-grow: splitRatio, flex-shrink: 1, flex-basis: 0
 * İki kardeş element'in flex değerleri oransal alan belirler:
 * flex: 60 vs flex: 40 → %60 vs %40 alan kaplar.
 * Bu, pixel hesabı gerektirmeden responsive çalışır.
 */

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useTranslation } from "react-i18next";
import { useVoiceStore } from "../../stores/voiceStore";
import ScreenSharePanel from "./ScreenSharePanel";
import ScreenShareResizeHandle from "./ScreenShareResizeHandle";

/** Split view yönü */
type LayoutMode = "vertical" | "horizontal";

/** splitRatio sınırları — bir panel minimum %20 olmalı, çok küçük olmasın */
const MIN_RATIO = 20;
const MAX_RATIO = 80;
const DEFAULT_RATIO = 50;

function ScreenShareView() {
  const { t } = useTranslation("voice");

  // watchingScreenShares: Hangi kullanıcıların yayınını izliyoruz
  const watchingScreenShares = useVoiceStore((s) => s.watchingScreenShares);

  // LiveKit'ten aktif screen share track'lerini al
  // withPlaceholder: false → sadece gerçek track'ler (placeholder yok)
  // onlySubscribed: false → tüm track'ler (local + remote)
  //   - Local participant'ın kendi yayını da dahil (preview için)
  //   - Remote unsubscribed track'ler de listede olur ama watchingScreenShares filtresi eler
  const allScreenShareTracks = useTracks(
    [{ source: Track.Source.ScreenShare, withPlaceholder: false }],
    { onlySubscribed: false }
  );

  // watchingScreenShares ile filtrele — sadece izlenmek istenen track'ler gösterilir.
  // Remote track'ler için VoiceStateManager subscription'ı kontrol eder (bant genişliği).
  // Local track için subscription gerekmez — sadece göster/gizle.
  const screenShareTracks = useMemo(
    () => allScreenShareTracks.filter(
      (t) => watchingScreenShares[t.participant.identity] ?? false
    ),
    [allScreenShareTracks, watchingScreenShares]
  );

  // Split view state — geçici UI state, Zustand'a gerek yok
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("vertical");
  const [splitRatio, setSplitRatio] = useState(DEFAULT_RATIO);

  // Container ref — resize delta'yı yüzdeye çevirmek için boyut gerekli
  const containerRef = useRef<HTMLDivElement>(null);

  // Track sayısı 2'den 1'e düştüğünde splitRatio'yu sıfırla.
  // Böylece tekrar 2 track olduğunda 50/50 başlar — temiz UX.
  useEffect(() => {
    if (screenShareTracks.length < 2) {
      setSplitRatio(DEFAULT_RATIO);
    }
  }, [screenShareTracks.length]);

  /**
   * Resize callback — pixel delta'yı yüzdeye çevirir.
   *
   * Hesaplama:
   * deltaPercent = (deltaPixel / containerSize) * 100
   * containerSize: layoutMode'a göre clientHeight veya clientWidth
   *
   * Clamp: MIN_RATIO-MAX_RATIO arası — bir panel en az %20 olmalı.
   */
  const handleResize = useCallback(
    (delta: number) => {
      if (!containerRef.current) return;

      const containerSize =
        layoutMode === "vertical"
          ? containerRef.current.clientHeight
          : containerRef.current.clientWidth;

      // Container henüz render olmamışsa veya boyutu 0 ise işlem yapma
      if (containerSize === 0) return;

      const deltaPercent = (delta / containerSize) * 100;
      setSplitRatio((prev) =>
        Math.max(MIN_RATIO, Math.min(MAX_RATIO, prev + deltaPercent))
      );
    },
    [layoutMode]
  );

  /** Layout mode toggle: vertical ↔ horizontal */
  const handleToggleLayout = useCallback(() => {
    setLayoutMode((prev) => (prev === "vertical" ? "horizontal" : "vertical"));
  }, []);

  // 0 track → gizle
  if (screenShareTracks.length === 0) return null;

  // 1 track → tek panel, tüm alan
  if (screenShareTracks.length === 1) {
    return (
      <div className="screen-share-view">
        <ScreenSharePanel trackRef={screenShareTracks[0]} />
      </div>
    );
  }

  // 2 track → split view (resize handle ile)
  if (screenShareTracks.length === 2) {
    const isVertical = layoutMode === "vertical";
    const splitClass = `screen-share-split ${isVertical ? "vertical" : "horizontal"}`;

    return (
      <div className="screen-share-view">
        {/* Layout toggle butonu — sağ üst köşe.
            z-10: Panel'lerin üstünde kalması için.
            Buton şu anki modun karşıtını gösterir (ne'ye geçileceğini). */}
        <button
          onClick={handleToggleLayout}
          className="screen-share-toggle"
          title={t("toggleLayout")}
        >
          {isVertical ? (
            // Şu an dikey (alt alta) → tıklayınca yatay (yan yana) olacak.
            // İkon: Dikey çizgiyle bölünmüş dikdörtgen (columns).
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
            // Şu an yatay (yan yana) → tıklayınca dikey (alt alta) olacak.
            // İkon: Yatay çizgiyle bölünmüş dikdörtgen (rows).
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

        {/* Split container — direction'a göre flex-col (dikey) veya flex-row (yatay).
            min-h-0 min-w-0: Flex child overflow trick — her iki yönde de. */}
        <div ref={containerRef} className={splitClass}>
          {/* Panel 1 — flex: splitRatio ile oransal alan kaplar.
              min-h-0 min-w-0: İç video element'inin container'ı taşırmasını engeller. */}
          <div style={{ flex: splitRatio }} className="screen-share-pane">
            <ScreenSharePanel trackRef={screenShareTracks[0]} />
          </div>

          {/* Sürüklenebilir divider — delta pixel cinsinden handleResize'a gelir */}
          <ScreenShareResizeHandle
            direction={layoutMode}
            onResize={handleResize}
          />

          {/* Panel 2 — flex: (100 - splitRatio) ile kalan alanı kaplar */}
          <div style={{ flex: 100 - splitRatio }} className="screen-share-pane">
            <ScreenSharePanel trackRef={screenShareTracks[1]} />
          </div>
        </div>
      </div>
    );
  }

  // 3+ track → CSS grid layout
  // 2 sütunlu grid: her panel eşit boyutta, satır sayısı otomatik artar.
  // Grid, 3+ screen share için resize handle'dan daha pratik —
  // her panel eşit alan alır, kullanıcı hangisini isterse fullscreen yapabilir.
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
