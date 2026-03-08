/**
 * useNotificationBadge — Unread message badge management.
 *
 * Two environments:
 * 1. Electron (Windows): Taskbar overlay icon via 16x16 canvas -> IPC
 * 2. Web (Browser): document.title prefix + favicon badge overlay
 *
 * Tracks combined channel + DM unread totals.
 */

import { useEffect, useRef } from "react";
import { useReadStateStore } from "../stores/readStateStore";
import { useDMStore } from "../stores/dmStore";
import { useServerStore } from "../stores/serverStore";

const BADGE_COLOR = "#ED4245";
const BADGE_TEXT_COLOR = "#FFFFFF";
const OVERLAY_ICON_SIZE = 16;
const FAVICON_SIZE = 32;
const BASE_TITLE = "mqvi";

// ─── Electron Overlay Badge ───

/** Renders 16x16 red circle with white count for taskbar overlay. */
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

/** Draws badge overlay on original favicon. Pill shape for multi-digit counts. */
function renderFaviconWithBadge(
  originalImg: HTMLImageElement,
  count: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = FAVICON_SIZE;
  canvas.height = FAVICON_SIZE;

  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  ctx.drawImage(originalImg, 0, 0, FAVICON_SIZE, FAVICON_SIZE);

  const label = count > 99 ? "99+" : String(count);
  const badgeRadius = 8;
  const badgeCenterX = FAVICON_SIZE - badgeRadius;
  const badgeCenterY = badgeRadius;

  ctx.fillStyle = BADGE_COLOR;
  ctx.beginPath();
  if (label.length > 1) {
    // Pill shape for wide numbers
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
    ctx.arc(badgeCenterX, badgeCenterY, badgeRadius, 0, Math.PI * 2);
  }
  ctx.fill();

  const fontSize = label.length > 2 ? 8 : label.length > 1 ? 10 : 12;
  ctx.fillStyle = BADGE_TEXT_COLOR;
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const textX =
    label.length > 1
      ? FAVICON_SIZE - badgeRadius - (label.length > 2 ? 2 : 1)
      : badgeCenterX;
  ctx.fillText(label, textX, badgeCenterY + 1);

  return canvas.toDataURL("image/png");
}

function setFavicon(href: string): void {
  const existing = document.querySelector(
    'link[rel="icon"][type="image/svg+xml"], link[rel="icon"]',
  ) as HTMLLinkElement | null;

  if (existing) {
    existing.href = href;
  }
}

/** Called in AppLayout. Watches unread stores and updates badge accordingly. */
export function useNotificationBadge(): void {
  const channelUnreads = useReadStateStore((s) => s.unreadCounts);
  const dmUnreads = useDMStore((s) => s.dmUnreadCounts);
  const activeServerId = useServerStore((s) => s.activeServerId);
  const mutedServerIds = useServerStore((s) => s.mutedServerIds);

  /** Original favicon image — loaded once, reused for badge overlay */
  const originalFaviconRef = useRef<HTMLImageElement | null>(null);
  const originalFaviconHrefRef = useRef<string>("");

  // Load original favicon once
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
    // Exclude muted server's channel unreads from badge total
    const isActiveMuted = activeServerId ? mutedServerIds.has(activeServerId) : false;
    const channelTotal = isActiveMuted
      ? 0
      : Object.values(channelUnreads).reduce((sum, c) => sum + c, 0);
    const dmTotal = Object.values(dmUnreads).reduce(
      (sum, c) => sum + c,
      0,
    );
    const total = channelTotal + dmTotal;

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
  }, [channelUnreads, dmUnreads, activeServerId, mutedServerIds]);
}
