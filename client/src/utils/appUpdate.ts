/** Whether the mobile app must, may, or need not be updated. */

/** Compares "1.10.2"-style versions part by part; a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export type UpdateState =
  | { kind: "none" }
  /** The store has a newer version; the user may put it off. */
  | { kind: "available"; id: string }
  /** This version is older than the server serves; nothing else until it is updated. */
  | { kind: "required" };

export type UpdateFacts = {
  current: string;
  /** The server's minimum for this platform; "" or null when there is none or it is unknown. */
  minimum: string | null;
  /** The newer store version, identified however the store names it; null when there is none. */
  storeVersionId: string | null;
  /** The store version the user last put off. */
  dismissedId: string | null;
};

export function decideUpdate({ current, minimum, storeVersionId, dismissedId }: UpdateFacts): UpdateState {
  if (minimum && compareVersions(current, minimum) < 0) return { kind: "required" };
  if (storeVersionId && storeVersionId !== dismissedId) return { kind: "available", id: storeVersionId };
  return { kind: "none" };
}
