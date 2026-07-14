/**
 * What the SERVER actually receives.
 *
 * Every other API test in this suite mocks apiClient, so none of them can see what it puts on
 * the wire — and that is exactly where the bug lived: markDMRead handed apiClient a string it
 * had already JSON.stringify'd, apiClient stringified it again, and the server got a JSON
 * string where it wanted an object. Every mark-read answered 400. The read watermark never
 * moved, so no DM push was ever suppressed and no delivered notification was ever pulled back
 * — the whole multi-device notification feature was dead on a single misplaced call, and the
 * mocks hid it.
 *
 * These tests go through the real apiClient with fetch mocked, and assert the decoded body.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../stores/authStore", () => ({
  getAccessToken: () => "test-token",
  useAuthStore: { getState: () => ({ forceLogout: vi.fn() }) },
}));

import { markDMRead } from "./dm";

const fetchMock = vi.fn();

/** The body as the server's json.Decode would see it. */
function decodedBody(): unknown {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string);
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ unread_count: 0 }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("markDMRead — the body on the wire", () => {
  it("sends an object, not a string of one", async () => {
    await markDMRead("chan-1", "msg-9");

    const body = decodedBody();
    expect(typeof body).toBe("object"); // a double-encoded body decodes to a string, and the server 400s
    expect(body).toEqual({ last_read_message_id: "msg-9" });
  });

  it("sends an empty id when the caller has no message to point at", async () => {
    await markDMRead("chan-1");

    expect(decodedBody()).toEqual({ last_read_message_id: "" });
  });

  it("posts to the channel's read endpoint", async () => {
    await markDMRead("chan-1", "msg-9");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/dms/channels/chan-1/read");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
