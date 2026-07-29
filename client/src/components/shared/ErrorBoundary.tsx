/**
 * ErrorBoundary — Catches render crashes.
 *
 * A transient crash is worth an automatic reload. A deterministic one is not: the same render runs
 * again, throws again, and reloads again, with no way out. So reloads are counted across reloads
 * (sessionStorage) and give way to a screen with a manual retry once the app has shown it cannot
 * get past the error on its own.
 *
 * Must be a class component (React limitation for error boundaries).
 */

import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import i18n from "../../i18n";

const RELOAD_COUNT_KEY = "mqvi:error-boundary-reloads";

/** Reloads spent on one error before the manual screen takes over. */
const MAX_RELOADS = 3;

const RELOAD_DELAY_MS = 2_000;

/** Rendering this long without a crash counts as recovered, so the next one starts fresh. */
const STABLE_MS = 30_000;

/**
 * sessionStorage throws in some privacy modes. These fail closed: with no way to count reloads
 * there is no way to bound them, so the boundary stops auto-reloading rather than risk the loop it
 * exists to prevent.
 */
function readReloadCount(): number | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_COUNT_KEY);
    if (raw === null) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return null;
  }
}

function writeReloadCount(value: number): boolean {
  try {
    sessionStorage.setItem(RELOAD_COUNT_KEY, String(value));
    return true;
  } catch {
    return false;
  }
}

function clearReloadCount(): void {
  try {
    sessionStorage.removeItem(RELOAD_COUNT_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
  /** The reload budget is spent (or uncountable) — show the manual screen instead. */
  giveUp: boolean;
};

class ErrorBoundary extends Component<Props, State> {
  private reloadTimerId: ReturnType<typeof setTimeout> | null = null;
  private stableTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, giveUp: false };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true };
  }

  componentDidMount() {
    // A reload that produced a stable app is a recovery, not another failed attempt. Without this
    // the counter carries over to an unrelated crash much later, which then skips its free retries.
    this.stableTimerId = setTimeout(clearReloadCount, STABLE_MS);
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught render error:", error, errorInfo);

    if (this.stableTimerId) {
      clearTimeout(this.stableTimerId);
      this.stableTimerId = null;
    }

    const spent = readReloadCount();
    if (spent === null || spent >= MAX_RELOADS || !writeReloadCount(spent + 1)) {
      this.setState({ giveUp: true });
      return;
    }

    this.reloadTimerId = setTimeout(() => {
      window.location.reload();
    }, RELOAD_DELAY_MS);
  }

  componentWillUnmount() {
    if (this.reloadTimerId) clearTimeout(this.reloadTimerId);
    if (this.stableTimerId) clearTimeout(this.stableTimerId);
  }

  private handleRetry = () => {
    clearReloadCount();
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    if (!this.state.giveUp) {
      return (
        <div className="error-boundary">
          <p className="error-boundary-message">{i18n.t("common:errorReloading")}</p>
        </div>
      );
    }

    return (
      <div className="error-boundary">
        <p className="error-boundary-title">{i18n.t("common:errorTitle")}</p>
        <p className="error-boundary-message">{i18n.t("common:errorPersistent")}</p>
        <button type="button" className="error-boundary-retry" onClick={this.handleRetry}>
          {i18n.t("common:errorRetry")}
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
