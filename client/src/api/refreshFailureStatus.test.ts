/**
 * A 401 whose refresh never got an answer is the server being away, not the session being dead.
 * At launch that difference is "connecting" versus the login screen.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { apiClient } from "./client";

const fetchMock = vi.fn();

function respond(status: number, body: unknown = { success: false, error: "x" }): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("access_token", "expired");
  localStorage.setItem("refresh_token", "sid.secret");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a 401 whose refresh fails", () => {
  it("should report no response when the refresh hit a server error", async () => {
    fetchMock.mockResolvedValueOnce(respond(401)).mockResolvedValueOnce(respond(502));

    const res = await apiClient("/users/me");

    expect(res.httpStatus).toBe(0);
    expect(localStorage.getItem("refresh_token")).toBe("sid.secret");
  });

  it("should report no response when the refresh could not reach the server", async () => {
    fetchMock.mockResolvedValueOnce(respond(401)).mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const res = await apiClient("/users/me");

    expect(res.httpStatus).toBe(0);
  });

  it("should report the 401 when the refresh was rejected", async () => {
    fetchMock.mockResolvedValueOnce(respond(401)).mockResolvedValueOnce(respond(401));

    const res = await apiClient("/users/me");

    expect(res.httpStatus).toBe(401);
    expect(localStorage.getItem("refresh_token")).toBeNull();
  });
});
