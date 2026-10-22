/**
 * Sends unhandled client errors and render crashes caught by the root error boundary to the server
 * (POST /api/client-errors), where they show in the platform admin logs under "client". A
 * signed-in client sends its session token, so the server can tell who hit the error. What
 * nobody needs to debug it is scrubbed here (and again on the server): tokens, email addresses,
 * URL query strings, ids, and home-folder names in file paths. Repeats are sent once per session,
 * and a session sends at most a handful.
 */

import { App } from "@capacitor/app";
import { getAccessToken } from "../api/client";
import { API_BASE_URL, getCapacitorPlatform, isCapacitor, isElectron } from "./constants";

export type ClientErrorReport = {
  /** "render": a crash the root error boundary caught; React does not pass those to window. */
  kind: "error" | "unhandledrejection" | "render";
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
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/g, "$1?[query]")
    // The OS account name in a file path (the Windows desktop app lives under C:/Users/<name>/).
    .replace(/([\\/](?:Users|home)[\\/])[^\\/:)'"\r\n]+/gi, "$1[user]")
    // Ids written into messages: uuids, and the 16-hex ids the database generates.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]")
    .replace(/\b[0-9a-f]{16,}\b/gi, "[id]");
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

/**
 * The route the user is on. Native shells route in the hash; a file:// page's path is where the
 * app is installed (C:/Users/<name>/...), never a route, so it is not used.
 */
function currentRoute(): string {
  const { pathname, hash, protocol } = window.location;
  if (hash.startsWith("#/")) return hash.slice(1);
  return protocol === "file:" ? "" : pathname;
}

/** `keepalive`: the request must outlive the page (a render crash, reloaded over in two seconds). */
type Sender = (reports: ClientErrorReport[], options: { keepalive: boolean }) => Promise<void>;

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
    if (batch.length) send(batch, { keepalive: false }).catch(() => {}); // undeliverable: dropped
    if (queue.length) timer = setTimeout(flush, FLUSH_DELAY_MS);
  };

  return {
    /** `immediate` skips the batching delay — for a crash the page is about to reload over. */
    report(kind: ClientErrorReport["kind"], message: string, stack: string, immediate = false) {
      if (!message || IGNORED.some((re) => re.test(message)) || EXTENSION_FRAME.test(stack)) return;
      const key = `${kind}|${message}|${stack.split("\n")[1] ?? ""}`;
      if (seen.has(key) || sent >= MAX_REPORTS_PER_SESSION) return;
      seen.add(key);
      sent++;
      const entry: ClientErrorReport = {
        kind,
        message: scrubText(message).slice(0, MAX_MESSAGE),
        stack: scrubText(stack).slice(0, MAX_STACK),
        route: scrubRoute(currentRoute()),
        platform: currentPlatform(),
        app_version: version(),
      };
      // Alone and at once: the server gives a lone render crash its own budget.
      if (immediate) {
        send([entry], { keepalive: true }).catch(() => {});
        return;
      }
      queue.push(entry);
      if (queue.length >= BATCH_SIZE) flush();
      else timer ??= setTimeout(flush, FLUSH_DELAY_MS);
    },
  };
}

/** The session token when signed in; an expired one only means the report arrives without a user. */
function authorizedHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const token = getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    // storage blocked: the report goes without a user
  }
  return headers;
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

export type ErrorReporting = {
  /** For createRoot's onCaughtError: a render crash, sent at once. */
  reportRenderCrash: (error: unknown, componentStack?: string) => void;
  dispose: () => void;
};

/** Starts reporting; a no-op in development, where the console already shows everything. */
export function installErrorReporting(): ErrorReporting {
  if (import.meta.env.DEV) return { reportRenderCrash: () => {}, dispose: () => {} };

  let version = typeof __APP_VERSION__ === "string" && !isCapacitor() ? __APP_VERSION__ : "";
  if (isCapacitor()) {
    App.getInfo()
      .then((info) => (version = info.version))
      .catch(() => {}); // reports go without a version
  }

  const post = (errors: ClientErrorReport[], keepalive: boolean) =>
    fetch(`${API_BASE_URL}/client-errors`, {
      method: "POST",
      headers: authorizedHeaders(),
      body: JSON.stringify({ errors }),
      credentials: "omit",
      keepalive,
    }).then(() => undefined);

  const reporter = createErrorReporter(
    // keepalive only where the page is about to go away. A cross-origin request with an
    // Authorization header needs a CORS preflight, which older engines refuse together with
    // keepalive; that refusal is immediate, so the plain request still goes before the reload.
    (errors, { keepalive }) => (keepalive ? post(errors, true).catch(() => post(errors, false)) : post(errors, false)),
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
  return {
    reportRenderCrash: (error, componentStack) => {
      const { message, stack } = describe(error);
      // The boundary reloads in two seconds; keepalive lets this request outlive the page.
      reporter.report("render", message, componentStack ? `${stack}\n${componentStack}` : stack, true);
    },
    dispose: () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    },
  };
}
