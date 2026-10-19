import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { reportScreenShareStop } from "./voice";

const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reportScreenShareStop", () => {
  it("should report to the voice channel's server with a whole, non-negative duration", async () => {
    await reportScreenShareStop("srv1", "ch1", "browser", "track_ended", 740.6, undefined);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/servers/srv1/voice/screen-share-stopped");
    expect(JSON.parse(init.body as string)).toEqual({ channel_id: "ch1", engine: "browser", reason: "track_ended", alive_ms: 741 });
  });

  it("should never send a negative duration", async () => {
    await reportScreenShareStop("srv1", "ch1", "browser", "start_failed", -3, "NotReadableError: Could not start video source");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.alive_ms).toBe(0);
    expect(body.detail).toBe("NotReadableError: Could not start video source");
  });
});
