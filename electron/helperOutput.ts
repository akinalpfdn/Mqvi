/**
 * helperOutput.ts — remembers what the game-capture helper last said.
 *
 * When the helper dies, Electron knows only the exit code, and "helper exited (code 1)" names the
 * messenger rather than the cause. The cause was already on the stream a moment earlier: the helper
 * prints "no hardware encoder MFT available", "window N no longer exists", "LiveKit connect
 * failed" and then exits. Holding on to that line is what makes a fallback report actionable.
 */

export type OutputTracker = {
  /** Feed one chunk of the helper's stdout/stderr. Chunks are not lines — see `pending`. */
  push(chunk: string): void;
  /** The line worth reporting, or "" if it has said nothing. */
  said(): string;
};

/** Lines that look like a failure, so a later stats line cannot bury the error. */
const ERROR_LINE = /error|panic|bail/i;
/** anyhow's chain header. Carries no information of its own — the causes under it do. */
const CHAIN_HEADER = /^caused by:?$/i;
/** Enough for a deep cause chain; the server truncates the report at 200 anyway. */
const MAX_ERROR_LEN = 300;
/**
 * env_logger's per-line prefix. Dropped from what gets reported: the log row carries its own
 * timestamp and the module never varies, so this is ~45 characters of the 200 the server keeps
 * spent on nothing. The level is read off the full line first — see `take`.
 */
const LOG_PREFIX = /^\[[^\]]*mqvi_game_capture\]\s*/;

export function createOutputTracker(): OutputTracker {
  // Every distinct error, oldest first. NOT just the newest: the helper reports a failure twice —
  // the pump logs the real cause as it dies, then `main` prints a generic wrapper on its way out.
  // Keeping only the newest reported "the hardware encoder produced no frames" to production and
  // threw away the line that named the fault. Oldest-first also puts the root cause where the
  // server's 200-character cut cannot reach it.
  const errors: string[] = [];
  let lastLine = "";
  // Whether the previous meaningful line was an error, so its indented causes attach to it.
  let inError = false;
  // Rust's stderr is unbuffered and anyhow's Debug impl writes in fragments, so a chunk boundary
  // can land inside a line. Kept here until the newline that ends it arrives.
  let pending = "";

  const totalLen = () => errors.reduce((n, e) => n + e.length + 3, 0);

  const addError = (line: string) => {
    for (let i = 0; i < errors.length; i++) {
      // One wrapping the other is the same failure said twice; keep the more specific wording.
      if (errors[i].includes(line)) return;
      if (line.includes(errors[i])) {
        errors[i] = line;
        return;
      }
    }
    if (totalLen() < MAX_ERROR_LEN) errors.push(line);
  };

  /** Attaches an anyhow cause line to the error it belongs to. */
  const addCause = (line: string) => {
    if (errors.length && totalLen() < MAX_ERROR_LEN) errors[errors.length - 1] += `; ${line}`;
  };

  const take = (raw: string) => {
    const full = raw.trim();
    // A blank line does not end a block: anyhow puts one between the message and "Caused by:".
    if (!full) return;

    // `main` returning Err prints the chain across several indented lines. Reported on its own, an
    // inner cause ("0: transport error") reads as the whole failure and the message that named what
    // failed is gone — so the causes are folded back onto it.
    if (inError && (/^\s/.test(raw) || CHAIN_HEADER.test(full))) {
      if (!CHAIN_HEADER.test(full)) addCause(full);
      return;
    }

    // Matched against the full line on purpose: `log::error!("encoder stopped")` says nothing that
    // looks like a failure, and the only evidence that it is one is the ERROR in the prefix that
    // the next line strips.
    inError = ERROR_LINE.test(full);
    const line = full.replace(LOG_PREFIX, "");
    lastLine = line;
    if (inError) addError(line);
  };

  return {
    push(chunk) {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const raw of lines) take(raw);
    },
    said() {
      // The helper is already dead whenever this is asked, so an unterminated tail is all there
      // will ever be of that line. Reporting it beats dropping it.
      if (pending) {
        take(pending);
        pending = "";
      }
      // Errors win over a merely-recent line: the helper narrates once a second, so a stats line
      // can land between the failure and the exit.
      return errors.join(" | ") || lastLine;
    },
  };
}
