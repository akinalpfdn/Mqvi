/**
 * ScreenShareResizeHandle — İki screen share paneli arasındaki sürüklenebilir divider.
 *
 * CSS class'ları: .screen-share-resize, .screen-share-resize.vertical,
 * .screen-share-resize.horizontal, .screen-share-resize-line
 *
 * Pointer Events API ile çalışır — harici kütüphane gerektirmez.
 *
 * Pointer Capture nedir?
 * setPointerCapture(pointerId): Mouse/touch event'lerini bu element'e kilitler.
 * Mouse element dışına çıksa bile event'ler gelmeye devam eder.
 * Bu sayede hızlı sürüklemede handle "kaybedilmez".
 *
 * İki yönde çalışır:
 * - vertical (alt alta): yatay çizgi, cursor-row-resize
 * - horizontal (yan yana): dikey çizgi, cursor-col-resize
 *
 * Delta hesabı: onPointerMove'da önceki pozisyon ile fark alınır
 * ve parent'a pixel cinsinden gönderilir. Parent bunu yüzdeye çevirir.
 */

import { useRef, useCallback } from "react";

type ScreenShareResizeHandleProps = {
  /** Layout yönü — handle'ın şekli ve sürükleme ekseni bunu belirler */
  direction: "vertical" | "horizontal";
  /** Sürükleme sırasında çağrılır — delta pixel cinsinden */
  onResize: (delta: number) => void;
};

function ScreenShareResizeHandle({ direction, onResize }: ScreenShareResizeHandleProps) {
  // Son pointer pozisyonunu tutar — delta hesabı için.
  // useRef kullanılır çünkü state güncellemesi her mouse move'da
  // re-render tetikler, ref tetiklemez → performans.
  const lastPosRef = useRef(0);
  const isDraggingRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Pointer'ı bu element'e kilitle — element dışına çıksa bile event gelir
      e.currentTarget.setPointerCapture(e.pointerId);
      isDraggingRef.current = true;

      // Başlangıç pozisyonunu kaydet
      lastPosRef.current = direction === "vertical" ? e.clientY : e.clientX;

      // Sürükleme sırasında metin seçimini engelle
      e.preventDefault();
    },
    [direction]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDraggingRef.current) return;

      const currentPos = direction === "vertical" ? e.clientY : e.clientX;
      const delta = currentPos - lastPosRef.current;
      lastPosRef.current = currentPos;

      // Delta'yı parent'a gönder — parent yüzdeye çevirecek
      if (delta !== 0) {
        onResize(delta);
      }
    },
    [direction, onResize]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      isDraggingRef.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
    },
    []
  );

  const handleClass = `screen-share-resize ${direction}`;

  return (
    <div
      className={handleClass}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      // touch-action: none — tarayıcının touch event'leri scroll için kullanmasını engeller
      style={{ touchAction: "none" }}
    >
      {/* Görsel çizgi — hover'da amber rengine geçer (CSS ile) */}
      <div className="screen-share-resize-line" />
    </div>
  );
}

export default ScreenShareResizeHandle;
