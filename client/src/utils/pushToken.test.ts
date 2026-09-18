/** Token registration retries, and never records a registration that did not happen. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { registerPushToken } = vi.hoisted(() => ({
  registerPushToken: vi.fn(async () => ({ success: true }) as { success: boolean; error?: string }),
}));

let server = "https://live.example";

vi.mock("../api/push", () => ({ registerPushToken, unregisterPushToken: vi.fn() }));
vi.mock("./constants", () => ({
  get SERVER_URL() {
    return server;
  },
  getCapacitorPlatform: () => "ios",
}));

import { syncVoipToken, clearCachedPushToken } from "./pushToken";

/** Runs the call to completion, stepping past the retry backoff without waiting for it. */
async function run(token: string): Promise<void> {
  const done = syncVoipToken(token);
  await vi.runAllTimersAsync();
  await done;
}

describe("syncVoipToken", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    server = "https://live.example";
    registerPushToken.mockReset();
    registerPushToken.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should register once and skip a repeat for the same server", async () => {
    await run("tok-1");
    await run("tok-1");
    expect(registerPushToken).toHaveBeenCalledTimes(1);
  });

  it("should retry until the server accepts the token", async () => {
    registerPushToken
      .mockResolvedValueOnce({ success: false, error: "network" })
      .mockResolvedValueOnce({ success: false, error: "503" })
      .mockResolvedValueOnce({ success: true });

    await run("tok-1");
    expect(registerPushToken).toHaveBeenCalledTimes(3);
  });

  it("should not record a registration that never succeeded, so a later attempt retries", async () => {
    registerPushToken.mockResolvedValue({ success: false, error: "down" });
    await run("tok-1");
    expect(registerPushToken).toHaveBeenCalledTimes(3);

    registerPushToken.mockResolvedValue({ success: true });
    await run("tok-1");
    expect(registerPushToken).toHaveBeenCalledTimes(4);
  });

  it("should register again when the app is pointed at a different server", async () => {
    await run("tok-1");
    server = "https://test.example";
    await run("tok-1");
    expect(registerPushToken).toHaveBeenCalledTimes(2);
  });

  it("should register again after a token change", async () => {
    await run("tok-1");
    await run("tok-2");
    expect(registerPushToken).toHaveBeenCalledTimes(2);
  });

  it("should forget the record when the caches are cleared on a failed session restore", async () => {
    await run("tok-1");
    clearCachedPushToken();
    await run("tok-1");
    expect(registerPushToken).toHaveBeenCalledTimes(2);
  });
});
