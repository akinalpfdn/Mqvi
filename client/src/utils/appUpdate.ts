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

/** A newer version the store offers this device — one it can install. */
export type StoreVersion = {
  /** What a dismissal is remembered by (Android: version code, iOS: version name). */
  id: string;
  /** The version name when the store says it (iOS); Play does not. */
  name: string | null;
};

export type UpdateFacts = {
  current: string;
  /** The server's minimum for this platform; "" or null when there is none or it is unknown. */
  minimum: string | null;
  store: StoreVersion | null;
  /** The store version the user last put off. */
  dismissedId: string | null;
};

/**
 * Required only when the store can actually satisfy the minimum: a minimum set above anything
 * this device can install (a typo on the server, a self-host ahead of the store, an iPhone too
 * old for the new version) would otherwise lock the user out with nothing to update to.
 */
export function decideUpdate({ current, minimum, store, dismissedId }: UpdateFacts): UpdateState {
  const belowMinimum = !!minimum && compareVersions(current, minimum) < 0;
  const storeSatisfies = !!store && (store.name === null || compareVersions(store.name, minimum ?? "0") >= 0);
  if (belowMinimum && storeSatisfies) return { kind: "required" };
  if (store && store.id !== dismissedId) return { kind: "available", id: store.id };
  return { kind: "none" };
}
