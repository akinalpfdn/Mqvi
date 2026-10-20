/** Client error reports: scrubbed before they leave, sent once per kind of error, in small batches. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@capacitor/app", () => ({ App: { getInfo: vi.fn() } }));

import { FLUSH_DELAY_MS, createErrorReporter, errorEventDetails, installErrorReporting, scrubRoute, scrubText, type ClientErrorReport } from "./errorReporter";

describe("installErrorReporting in a production build", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends a render crash the root boundary caught at once, with its component stack", () => {
    vi.stubEnv("DEV", false);
    localStorage.setItem("access_token", "signed-in-token");
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const reporting = installErrorReporting();

    reporting.reportRenderCrash(new TypeError("x is undefined"), "\n    at ChannelList");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/client-errors$/);
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer signed-in-token");
    const sentReport = (JSON.parse(String(init.body)) as { errors: ClientErrorReport[] }).errors[0];
    expect(sentReport).toMatchObject({ kind: "render", message: "TypeError: x is undefined" });
    expect(sentReport.stack).toContain("at ChannelList");
    reporting.dispose();
  });
});

describe("error events", () => {
  it("reads a cross-origin script error by its message, not as \"null\"", () => {
    expect(errorEventDetails({ error: null, message: "Script error." })).toEqual({ message: "Script error.", stack: "" });
  });

  it("reads a real error by its name, message and stack", () => {
    const error = new TypeError("x is undefined");
    expect(errorEventDetails({ error, message: "ignored" })).toEqual({ message: "TypeError: x is undefined", stack: error.stack });
  });
});

describe("scrubbing", () => {
  it.each([
    ["token eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl x", "token [token] x"],
    ["Authorization: Bearer abc.def", "Authorization: Bearer [token]"],
    ["no user ali.veli@example.com", "no user [email]"],
    ["GET https://mqvi.net/f/a.png?token=s&exp=1 failed", "GET https://mqvi.net/f/a.png?[query] failed"],
    ["No session found for 9f3a1c2b4d5e6f70:0193f1e2-7a4b-4c3d-8e9f-001122334455", "No session found for [id]:[id]"],
    [
      "at f (file:///C:/Users/Ali Veli/AppData/Local/Programs/mqvi/dist/assets/index-x.js:1:2)",
      "at f (file:///C:/Users/[user]/AppData/Local/Programs/mqvi/dist/assets/index-x.js:1:2)",
    ],
    ["at g (/home/ali/mqvi/x.js:3:4)", "at g (/home/[user]/mqvi/x.js:3:4)"],
  ])("%s", (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });

  it("keeps the route's shape and drops its ids", () => {
    expect(scrubRoute("/channels/0193f1e2-7a4b-7c3d/12345678?tab=1#x")).toBe("/channels/:id/:id");
    expect(scrubRoute("/settings/profile")).toBe("/settings/profile");
  });
});

describe("createErrorReporter", () => {
  let sent: ClientErrorReport[][];
  const send = vi.fn(async (reports: ClientErrorReport[]) => {
    sent.push(reports);
  });
  const reporter = () => createErrorReporter(send, () => "1.1.0");

  beforeEach(() => {
    sent = [];
    send.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a report a moment after the error, scrubbed and stamped", () => {
    reporter().report("error", "failed for a@b.co", "Error\n    at x (app.js:1:2)");
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toMatchObject({ kind: "error", message: "failed for [email]", platform: "web", app_version: "1.1.0" });
  });

  it("sends a render crash at once and alone, leaving queued reports to their batch", () => {
    const r = reporter();
    r.report("error", "earlier ws error", "");
    r.report("render", "TypeError: x is undefined", "", true);
    expect(sent).toEqual([[expect.objectContaining({ kind: "render" })]]);

    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(sent[1]).toEqual([expect.objectContaining({ message: "earlier ws error" })]);
  });

  it("sends the same error once", () => {
    const r = reporter();
    for (let i = 0; i < 4; i++) r.report("error", "boom", "Error\n    at x (app.js:1:2)");
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(sent.flat()).toHaveLength(1);
  });

  it("sends a full batch at once and the rest after", () => {
    const r = reporter();
    for (let i = 0; i < 7; i++) r.report("error", `boom ${i}`, "");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(5);

    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(sent.flat()).toHaveLength(7);
  });

  it("stops after a session's worth of different errors", () => {
    const r = reporter();
    for (let i = 0; i < 50; i++) r.report("error", `boom ${i}`, "");
    vi.advanceTimersByTime(FLUSH_DELAY_MS * 10);
    expect(sent.flat()).toHaveLength(20);
  });

  it("ignores noise nobody can act on", () => {
    const r = reporter();
    r.report("error", "ResizeObserver loop completed with undelivered notifications.", "");
    r.report("error", "Script error.", "");
    r.report("error", "boom", "Error\n    at chrome-extension://abc/content.js:1:1");
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(send).not.toHaveBeenCalled();
  });

  it("drops a batch that cannot be delivered without throwing", async () => {
    const failing = createErrorReporter(async () => Promise.reject(new Error("offline")), () => "");
    failing.report("error", "boom", "");
    expect(() => vi.advanceTimersByTime(FLUSH_DELAY_MS)).not.toThrow();
  });
});
