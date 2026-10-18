/**
 * Reveals the guide one item at a time, like a person writing: each line behind a typing beat as
 * long as the line, then — after time to read it — the cards, one by one. Items already seen on this device appear at once.
 * While paused (another dialog is in front) nothing new appears, so nothing plays unseen.
 */

import { useEffect, useMemo, useState } from "react";

/** Typing a line: a base beat plus time per character, so a long line takes longer to "write". */
export const GUIDE_TYPING_BASE_MS = 900;
export const GUIDE_TYPING_PER_CHAR_MS = 22;
export const GUIDE_TYPING_MAX_MS = 3200;
/** Time to read what was just said before the first card arrives. */
export const GUIDE_FIRST_CARD_MS = 1400;
/** The pause between one card and the next. */
export const GUIDE_CARD_MS = 800;

/** How long the guide takes to type `text`. */
export function typingMs(text: string): number {
  return Math.min(GUIDE_TYPING_MAX_MS, GUIDE_TYPING_BASE_MS + text.length * GUIDE_TYPING_PER_CHAR_MS);
}

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

/** One thing to reveal: `typed` shows typing dots while waiting `delayMs` before it appears. */
export type GuideRevealItem = { id: string; typed: boolean; delayMs: number };

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
      next.delayMs,
    );
    return () => clearTimeout(timer);
  }, [next, paused, visible, seen, userId]);

  return { visible, typing: !!next && next.typed && !paused };
}
