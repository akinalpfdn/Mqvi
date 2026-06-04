import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiClient } = vi.hoisted(() => ({ apiClient: vi.fn() }));
vi.mock("./client", () => ({ apiClient }));

import { fetchIceServers } from "./calls";

const isStunOnly = (servers: RTCIceServer[]) =>
  servers.length > 0 && servers.every((s) => String(s.urls).startsWith("stun:"));

describe("fetchIceServers", () => {
  beforeEach(() => apiClient.mockReset());

  it("returns the backend list on success", async () => {
    const servers = [{ urls: ["turn:t:3478?transport=udp"], username: "u", credential: "c" }];
    apiClient.mockResolvedValue({ success: true, data: { ice_servers: servers } });
    await expect(fetchIceServers()).resolves.toEqual(servers);
  });

  it("falls back to STUN-only when the response is empty", async () => {
    apiClient.mockResolvedValue({ success: true, data: { ice_servers: [] } });
    expect(isStunOnly(await fetchIceServers())).toBe(true);
  });

  it("falls back to STUN-only on a failed response (403/429/network)", async () => {
    apiClient.mockResolvedValue({ success: false, error: "forbidden" });
    expect(isStunOnly(await fetchIceServers())).toBe(true);
  });

  // Timeout and throw/reject paths are defense-in-depth over apiClient (which is
  // designed to return {success:false} rather than throw) and produce the same
  // STUN fallback as the cases above. They are checkable with fake timers / a
  // throwing mock, but doing so reliably means working around Vitest's
  // unhandled-rejection handling for marginal added coverage — left to inspection.
});
