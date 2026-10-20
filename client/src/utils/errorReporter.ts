/**
 * Sends unhandled client errors to the server (POST /api/client-errors), where they show in the
 * platform admin logs under "client". Nothing identifies the user: no user id is sent, and
 * tokens, email addresses, URL query strings and ids in the route are scrubbed here (and again
 * on the server). Repeats are sent once per session, and a session sends at most a handful.
 */

import { App } from "@capacitor/app";
import { API_BASE_URL, getCapacitorPlatform, isCapacitor, isElectron } from "./constants";

export type ClientErrorReport = {
  kind: "error" | "unhandledrejection";
  message: string;
  stack: string;
  route: string;
  platform: string;
  app_version: string;
};

const MAX_REPORTS_PER_SESSION = 20;
const BATCH_SIZE = 5;
export const FLUSH_DELAY_MS = 2000;
const MAX_MESSAGE = 500;
const MAX_STACK = 2000;

/** Noise nobody can act on: browser quirks, opaque cross-origin errors, browser extensions. */
const IGNORED = [/ResizeObserver loop/i, /^Script error\.?$/i];
const EXTENSION_FRAME = /(chrome|moz|safari)-extension:\/\//;

export function scrubText(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[token]")
    .replace(/bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [token]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/g, "$1?[query]");
}

/** Keeps the shape of the route (/channels/:id/:id), drops its ids. */
export function scrubRoute(path: string): string {
  return path
    .split(/[?#]/)[0]
    .split("/")
    .map((seg) => (/^([A-Za-z0-9_-]{16,}|[0-9]{4,})$/.test(seg) ? ":id" : seg))
    .join("/");
}

function currentPlatform(): string {
  if (isCapacitor()) return getCapacitorPlatform() === "ios" ? "ios" : "android";
  return isElectron() ? "electron" : "web";
}

/** The route the user is on; native shells route in the hash. */
function currentRoute(): string {
  const { pathname, hash } = window.location;
  return hash.startsWith("#/") ? hash.slice(1) : pathname;
}

type Sender = (reports: ClientErrorReport[]) => Promise<void>;

/** The batching and dedupe behind installErrorReporting, with the transport passed in. */
export function createErrorReporter(send: Sender, version: () => string) {
  const seen = new Set<string>();
  let queue: ClientErrorReport[] = [];
  let sent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const batch = queue.slice(0, BATCH_SIZE);
    queue = queue.slice(BATCH_SIZE);
    if (batch.length) send(batch).catch(() => {}); // a report that cannot be delivered is dropped
    if (queue.length) timer = setTimeout(flush, FLUSH_DELAY_MS);
  };

  return {
    report(kind: ClientErrorReport["kind"], message: string, stack: string) {
      if (!message || IGNORED.some((re) => re.test(message)) || EXTENSION_FRAME.test(stack)) return;
      const key = `${kind}|${message}|${stack.split("\n")[1] ?? ""}`;
      if (seen.has(key) || sent >= MAX_REPORTS_PER_SESSION) return;
      seen.add(key);
      sent++;
      queue.push({
        kind,
        message: scrubText(message).slice(0, MAX_MESSAGE),
        stack: scrubText(stack).slice(0, MAX_STACK),
        route: scrubRoute(currentRoute()),
        platform: currentPlatform(),
        app_version: version(),
      });
      if (queue.length >= BATCH_SIZE) flush();
      else timer ??= setTimeout(flush, FLUSH_DELAY_MS);
    },
  };
}

function describe(reason: unknown): { message: string; stack: string } {
  if (reason instanceof Error) return { message: `${reason.name}: ${reason.message}`, stack: reason.stack ?? "" };
  return { message: typeof reason === "string" ? reason : String(reason), stack: "" };
}

/**
 * What an `error` event says. A script from another origin gives `error: null` and only the
 * message "Script error." — that has to reach the noise filter as such, not as "null".
 */
export function errorEventDetails(event: Pick<ErrorEvent, "error" | "message">): { message: string; stack: string } {
  return event.error != null ? describe(event.error) : { message: event.message, stack: "" };
}

/** Starts reporting; a no-op in development, where the console already shows everything. */
export function installErrorReporting(): () => void {
  if (import.meta.env.DEV) return () => {};

  let version = typeof __APP_VERSION__ === "string" && !isCapacitor() ? __APP_VERSION__ : "";
  if (isCapacitor()) {
    App.getInfo()
      .then((info) => (version = info.version))
      .catch(() => {}); // reports go without a version
  }

  const reporter = createErrorReporter(
    (errors) =>
      fetch(`${API_BASE_URL}/client-errors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ errors }),
        credentials: "omit",
        keepalive: true,
      }).then(() => undefined),
    () => version,
  );

  const onError = (event: ErrorEvent) => {
    const { message, stack } = errorEventDetails(event);
    reporter.report("error", message, stack);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const { message, stack } = describe(event.reason);
    reporter.report("unhandledrejection", message, stack);
  };

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
