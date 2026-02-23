/**
 * useResizeHandle — Panel genişliğini sürükleyerek ayarlama hook'u.
 *
 * Kullanım:
 * ```tsx
 * const { width, handleMouseDown } = useResizeHandle({
 *   initialWidth: 240,
 *   minWidth: 180,
 *   maxWidth: 400,
 *   direction: "right",
 *   storageKey: "mqvi_sidebar_width",
 * });
 * ```
 *
 * direction:
 * - "right" → sağa doğru sürüklemek genişletir (sol sidebar)
 * - "left"  → sola doğru sürüklemek genişletir (sağ sidebar)
 *
 * Mouse event'leri document seviyesinde dinlenir (mouseup/mousemove).
 * Bu sayede cursor handle'ın dışına çıksa bile drag devam eder.
 *
 * Drag sırasında `user-select: none` uygulanır → metin seçimi engellenir.
 * Drag bittiğinde geri alınır.
 */

import { useState, useCallback, useRef, useEffect } from "react";

type ResizeHandleOptions = {
  /** Başlangıç genişliği (px) — localStorage'ta değer yoksa kullanılır */
  initialWidth: number;
  /** Minimum genişlik (px) */
  minWidth: number;
  /** Maximum genişlik (px) */
  maxWidth: number;
  /**
   * Sürükleme yönü:
   * - "right": sağa sürükle = genişlet (sol sidebar)
   * - "left": sola sürükle = genişlet (sağ sidebar)
   */
  direction: "right" | "left";
  /** localStorage key — persist etmek için */
  storageKey: string;
  /** Genişlik değiştiğinde çağrılır (opsiyonel) */
  onWidthChange?: (width: number) => void;
};

type ResizeHandleResult = {
  /** Mevcut genişlik (px) */
  width: number;
  /** Resize handle'ın onMouseDown handler'ı */
  handleMouseDown: (e: React.MouseEvent) => void;
  /** Drag aktif mi? (handle'a görsel feedback için) */
  isDragging: boolean;
};

/**
 * loadWidth — localStorage'dan kaydedilmiş genişliği okur.
 * Geçersiz veya yok ise null döner.
 */
function loadWidth(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    }
  } catch {
    /* localStorage erişim hatası */
  }
  return null;
}

/**
 * saveWidth — Genişliği localStorage'a yazar.
 */
function saveWidth(key: string, width: number): void {
  try {
    localStorage.setItem(key, String(Math.round(width)));
  } catch {
    /* localStorage dolu */
  }
}

export function useResizeHandle(options: ResizeHandleOptions): ResizeHandleResult {
  const { initialWidth, minWidth, maxWidth, direction, storageKey, onWidthChange } = options;

  const [width, setWidth] = useState(() => {
    const saved = loadWidth(storageKey);
    if (saved !== null) {
      return Math.min(Math.max(saved, minWidth), maxWidth);
    }
    return initialWidth;
  });

  const [isDragging, setIsDragging] = useState(false);

  /**
   * Drag state ref'leri — event listener'lar closure'da
   * stale state yakalar, ref ile güncel değere erişiriz.
   */
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      setIsDragging(true);

      // Drag sırasında metin seçimini engelle
      document.body.style.userSelect = "none";
      document.body.style.cursor = direction === "right" ? "col-resize" : "col-resize";
    },
    [width, direction]
  );

  useEffect(() => {
    if (!isDragging) return;

    function handleMouseMove(e: MouseEvent) {
      const delta = e.clientX - startXRef.current;
      const newWidth =
        direction === "right"
          ? startWidthRef.current + delta
          : startWidthRef.current - delta;

      const clamped = Math.min(Math.max(newWidth, minWidth), maxWidth);
      setWidth(clamped);
      onWidthChange?.(clamped);
    }

    function handleMouseUp() {
      setIsDragging(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";

      // Drag bittiğinde son genişliği kaydet
      // Burada startWidthRef + son delta'yı kullanmak yerine
      // en güncel width'i okumak lazım — setTimeout ile çözüyoruz
      // çünkü React state async güncellenir.
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, direction, minWidth, maxWidth, onWidthChange]);

  /**
   * Drag bittiğinde (isDragging false olunca) son genişliği persist et.
   * isDragging → false geçişini takip eder.
   */
  const prevDraggingRef = useRef(false);
  useEffect(() => {
    if (prevDraggingRef.current && !isDragging) {
      saveWidth(storageKey, width);
    }
    prevDraggingRef.current = isDragging;
  }, [isDragging, width, storageKey]);

  return { width, handleMouseDown, isDragging };
}
