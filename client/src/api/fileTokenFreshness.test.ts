import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ensureFreshFileToken } from "./client";

function jwtExpiringIn(seconds: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds }));
  return `header.${payload}.sig`;
}

const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        data: { access_token: jwtExpiringIn(900), refresh_token: "sid.next", file_token: jwtExpiringIn(86_400) },
      }),
      { status: 200 }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureFreshFileToken", () => {
  it("should refresh when the file token has lapsed", async () => {
    localStorage.setItem("file_token", jwtExpiringIn(-60));
    localStorage.setItem("refresh_token", "sid.current");

    await ensureFreshFileToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/auth/refresh");
    expect(localStorage.getItem("refresh_token")).toBe("sid.next");
  });

  it("should leave a valid file token alone", async () => {
    localStorage.setItem("file_token", jwtExpiringIn(3_600));
    localStorage.setItem("refresh_token", "sid.current");

    await ensureFreshFileToken();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should not try to refresh when signed out", async () => {
    localStorage.setItem("file_token", jwtExpiringIn(-60));

    await ensureFreshFileToken();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
