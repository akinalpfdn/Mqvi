/**
 * useNotificationBadge — Okunmamış mesaj badge yönetimi.
 *
 * İki ortamda çalışır:
 *
 * 1. **Electron (Windows):** Taskbar overlay icon — Discord/Xbox tarzı kırmızı badge.
 *    16x16 canvas → dataURL → IPC → main process → setOverlayIcon.
 *    Tray tooltip da güncellenir.
 *
 * 2. **Web (Browser):** WhatsApp Web tarzı:
 *    - document.title → "(5) mqvi" / "mqvi"
 *    - Favicon badge — orijinal favicon üzerine kırmızı daire + sayı çizilir.
 *      Orijinal favicon bir kez yüklenir (Image), her count değişiminde
 *      32x32 canvas'a orijinal + badge overlay çizilir, <link rel="icon">
 *      güncellenir.
 *
 * Her iki ortamda da kanal + DM unread toplamı izlenir.
 */

import { useEffect, useRef } from "react";
import { useReadStateStore } from "../stores/readStateStore";
import { useDMStore } from "../stores/dmStore";

/** Badge rengi — Discord kırmızısı */
const BADGE_COLOR = "#ED4245";
/** Badge text rengi */
const BADGE_TEXT_COLOR = "#FFFFFF";

/** Electron overlay icon boyutu (Windows standart) */
const OVERLAY_ICON_SIZE = 16;

/** Favicon canvas boyutu — yüksek çözünürlüklü favicon */
const FAVICON_SIZE = 32;

/** Varsayılan sayfa başlığı */
const BASE_TITLE = "mqvi";

// ─── Electron Overlay Badge ───

/**
 * renderOverlayIcon — 16x16 canvas'a kırmızı daire + beyaz sayı çizer.
 * Electron main process'e gönderilecek dataURL üretir.
 */
function renderOverlayIcon(count: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = OVERLAY_ICON_SIZE;
  canvas.height = OVERLAY_ICON_SIZE;

  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  ctx.fillStyle = BADGE_COLOR;
  ctx.beginPath();
  ctx.arc(
    OVERLAY_ICON_SIZE / 2,
    OVERLAY_ICON_SIZE / 2,
    OVERLAY_ICON_SIZE / 2,
    0,
    Math.PI * 2,
  );
  ctx.fill();

  const label = count > 99 ? "99+" : String(count);
  const fontSize = label.length > 2 ? 7 : label.length > 1 ? 9 : 11;
  ctx.fillStyle = BADGE_TEXT_COLOR;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, OVERLAY_ICON_SIZE / 2, OVERLAY_ICON_SIZE / 2 + 1);

  return canvas.toDataURL("image/png");
}

// ─── Favicon Badge ───

/**
 * renderFaviconWithBadge — Orijinal favicon üzerine kırmızı badge overlay çizer.
 *
 * 32x32 canvas'a orijinal ikon çizilir, sağ üst köşeye badge eklenir.
 * Badge boyutu sayı uzunluğuna göre ayarlanır (tek hane: daire, çok hane: pill).
 */
function renderFaviconWithBadge(
  originalImg: HTMLImageElement,
  count: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = FAVICON_SIZE;
  canvas.height = FAVICON_SIZE;

  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  // Orijinal favicon'u çiz
  ctx.drawImage(originalImg, 0, 0, FAVICON_SIZE, FAVICON_SIZE);

  // Badge parametreleri
  const label = count > 99 ? "99+" : String(count);
  const badgeRadius = 8;
  const badgeCenterX = FAVICON_SIZE - badgeRadius;
  const badgeCenterY = badgeRadius;

  // Kırmızı daire badge
  ctx.fillStyle = BADGE_COLOR;
  ctx.beginPath();
  if (label.length > 1) {
    // Pill şekli — geniş sayılar için
    const padding = label.length > 2 ? 4 : 2;
    const pillWidth = badgeRadius + padding;
    const left = FAVICON_SIZE - pillWidth - badgeRadius;
    ctx.moveTo(left + badgeRadius, badgeCenterY - badgeRadius);
    ctx.lineTo(badgeCenterX, badgeCenterY - badgeRadius);
    ctx.arc(badgeCenterX, badgeCenterY, badgeRadius, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(left + badgeRadius, badgeCenterY + badgeRadius);
    ctx.arc(
      left + badgeRadius,
      badgeCenterY,
      badgeRadius,
      Math.PI / 2,
      -Math.PI / 2,
    );
  } else {
    // Basit daire — tek hane
    ctx.arc(badgeCenterX, badgeCenterY, badgeRadius, 0, Math.PI * 2);
  }
  ctx.fill();

  // Beyaz sayı
  const fontSize = label.length > 2 ? 8 : label.length > 1 ? 10 : 12;
  ctx.fillStyle = BADGE_TEXT_COLOR;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Pill için text merkezi sola kaymalı
  const textX =
    label.length > 1
      ? FAVICON_SIZE - badgeRadius - (label.length > 2 ? 2 : 1)
      : badgeCenterX;
  ctx.fillText(label, textX, badgeCenterY + 1);

  return canvas.toDataURL("image/png");
}

/**
 * setFavicon — <link rel="icon"> elementini günceller.
 * Mevcut favicon link'i bulunur, href değiştirilir.
 */
function setFavicon(href: string): void {
  const existing = document.querySelector(
    'link[rel="icon"][type="image/svg+xml"], link[rel="icon"]',
  ) as HTMLLinkElement | null;

  if (existing) {
    existing.href = href;
  }
}

/**
 * useNotificationBadge — AppLayout'ta çağrılır.
 *
 * Zustand store'lardan toplam okunmamış sayıyı izler:
 * - Electron: taskbar overlay icon günceller
 * - Web: document.title + favicon badge günceller
 */
export function useNotificationBadge(): void {
  const channelUnreads = useReadStateStore((s) => s.unreadCounts);
  const dmUnreads = useDMStore((s) => s.dmUnreadCounts);

  /**
   * Orijinal favicon Image referansı — bir kez yüklenir, sonra her badge
   * güncellemesinde canvas'a overlay olarak çizilir. useRef ile tutulur
   * çünkü Image yükleme async — load event'i ile resolve edilir.
   */
  const originalFaviconRef = useRef<HTMLImageElement | null>(null);
  const originalFaviconHrefRef = useRef<string>("");

  // Orijinal favicon'u bir kez yükle
  useEffect(() => {
    const link = document.querySelector(
      'link[rel="icon"]',
    ) as HTMLLinkElement | null;
    if (!link) return;

    originalFaviconHrefRef.current = link.href;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      originalFaviconRef.current = img;
    };
    img.src = link.href;
  }, []);

  useEffect(() => {
    // Toplam okunmamış sayı hesapla
    const channelTotal = Object.values(channelUnreads).reduce(
      (sum, c) => sum + c,
      0,
    );
    const dmTotal = Object.values(dmUnreads).reduce(
      (sum, c) => sum + c,
      0,
    );
    const total = channelTotal + dmTotal;

    // ─── Document Title (her ortamda) ───
    document.title = total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;

    // ─── Electron: Taskbar Overlay Icon ───
    if (window.electronAPI) {
      if (total === 0) {
        window.electronAPI.setBadgeCount(0, null);
      } else {
        const dataURL = renderOverlayIcon(total);
        window.electronAPI.setBadgeCount(total, dataURL);
      }
    }

    // ─── Web: Favicon Badge ───
    if (originalFaviconRef.current) {
      if (total === 0) {
        // Orijinal favicon'a geri dön
        setFavicon(originalFaviconHrefRef.current);
      } else {
        const badgedFavicon = renderFaviconWithBadge(
          originalFaviconRef.current,
          total,
        );
        if (badgedFavicon) {
          setFavicon(badgedFavicon);
        }
      }
    }
  }, [channelUnreads, dmUnreads]);
}
