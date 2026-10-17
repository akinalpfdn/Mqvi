/**
 * Reveals the guide one item at a time, like a person writing: each line behind a typing beat,
 * each card a moment after the one before. Items already seen on this device appear at once.
 * While paused (another dialog is in front) nothing new appears, so nothing plays unseen.
 */

import { useEffect, useMemo, useState } from "react";

/** How long the guide "types" before a line. */
export const GUIDE_TYPING_MS = 900;
/** The pause between one card and the next. */
export const GUIDE_CARD_MS = 450;

function storageKey(userId: string): string {
  return `mqvi_guide_seen:${userId}`;
}

function loadSeen(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    // Unreadable or blocked storage: every item is revealed again, nothing breaks.
    return new Set();
  }
}

function saveSeen(userId: string, seen: Set<string>): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify([...seen]));
  } catch {
    // Storage full or blocked: the items are simply revealed again next time.
  }
}

export type GuideRevealItem = { id: string; typed: boolean };

/** How many items to show, and whether the next one is being typed. */
export function useGuideReveal(
  items: readonly GuideRevealItem[],
  userId: string,
  paused = false,
): { visible: number; typing: boolean } {
  const seen = useMemo(() => loadSeen(userId), [userId]);
  const leadingSeen = useMemo(() => {
    let n = 0;
    while (n < items.length && seen.has(items[n].id)) n++;
    return n;
  }, [items, seen]);

  const [revealed, setRevealed] = useState(leadingSeen);
  const visible = Math.min(items.length, Math.max(revealed, leadingSeen));
  const next = visible < items.length ? items[visible] : null;

  useEffect(() => {
    if (!next || paused) return;
    const timer = setTimeout(
      () => {
        seen.add(next.id);
        saveSeen(userId, seen);
        setRevealed(visible + 1);
      },
      next.typed ? GUIDE_TYPING_MS : GUIDE_CARD_MS,
    );
    return () => clearTimeout(timer);
  }, [next, paused, visible, seen, userId]);

  return { visible, typing: !!next && next.typed && !paused };
}
