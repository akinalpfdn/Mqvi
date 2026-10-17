/**
 * Reveals the guide's lines one at a time behind a short typing beat, like a person writing.
 * Lines the user has already seen (on this device) appear at once; only new ones are typed.
 */

import { useEffect, useMemo, useState } from "react";

/** How long the guide "types" before each new line. */
export const GUIDE_TYPING_MS = 900;

function storageKey(userId: string): string {
  return `mqvi_guide_seen:${userId}`;
}

function loadSeen(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    // Unreadable or blocked storage: every line is typed again, nothing breaks.
    return new Set();
  }
}

function saveSeen(userId: string, seen: Set<string>): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify([...seen]));
  } catch {
    // Storage full or blocked: the lines are simply typed again next time.
  }
}

/** How many of `ids` to show, and whether the next one is being typed. */
export function useGuideReveal(ids: readonly string[], userId: string): { visible: number; typing: boolean } {
  const seen = useMemo(() => loadSeen(userId), [userId]);
  const leadingSeen = useMemo(() => {
    let n = 0;
    while (n < ids.length && seen.has(ids[n])) n++;
    return n;
  }, [ids, seen]);

  const [revealed, setRevealed] = useState(leadingSeen);
  const visible = Math.min(ids.length, Math.max(revealed, leadingSeen));
  const typing = visible < ids.length;

  useEffect(() => {
    if (!typing) return;
    const timer = setTimeout(() => {
      seen.add(ids[visible]);
      saveSeen(userId, seen);
      setRevealed(visible + 1);
    }, GUIDE_TYPING_MS);
    return () => clearTimeout(timer);
  }, [typing, visible, ids, seen, userId]);

  return { visible, typing };
}
