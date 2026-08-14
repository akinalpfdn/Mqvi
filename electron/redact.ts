/**
 * redact.ts — strips known secret values out of text that is about to leave the main process.
 *
 * The game-capture helper is handed a LiveKit token and the room's E2EE passphrase on stdin, and
 * its last output line is now attached to the fallback report that reaches app_logs — where an
 * operator reads it and screenshots it.
 *
 * Matching is by exact value, not by pattern: we know precisely what we passed in, so there are no
 * false positives and no clever regex to get wrong. The helper does not print either secret today
 * — this exists so that a log line added later cannot quietly publish one.
 */

/** Builds a redactor for the given secrets. Empty/undefined entries are ignored. */
export function createRedactor(secrets: (string | undefined)[]): (line: string) => string {
  // Longest first: if one secret contains another, replacing the short one first would leave a
  // mangled tail of the long one in place rather than removing it whole.
  const real = secrets.filter((s): s is string => !!s).sort((a, b) => b.length - a.length);
  if (real.length === 0) return (line) => line;

  return (line) => real.reduce((acc, secret) => acc.split(secret).join("[redacted]"), line);
}
