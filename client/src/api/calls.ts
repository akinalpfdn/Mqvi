/**
 * Calls API — ICE servers (STUN + TURN relay) for P2P calls.
 */

import { apiClient } from "./client";

// STUN-only fallback. Used when the backend fetch fails (offline, 403, 429) so a
// call still attempts to connect — it just loses the relay fallback.
const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// Bound the wait so a hung server/proxy can't block the call forever. The timer
// aborts the actual request (not just our wait), so a timed-out fetch doesn't keep
// running in the background and mint an unneeded credential / consume rate limit.
const ICE_FETCH_TIMEOUT_MS = 4000;

/**
 * Fetches the ICE server list (STUN + TURN with fresh short-lived credentials)
 * for the current P2P call. Must be called once the call is "active" — the
 * backend gates this on an accepted call. Never throws and never blocks beyond
 * ICE_FETCH_TIMEOUT_MS: on any failure or timeout it returns STUN-only so the
 * call is not held up by TURN.
 */
export async function fetchIceServers(): Promise<RTCIceServer[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ICE_FETCH_TIMEOUT_MS);
  try {
    const res = await apiClient<{ ice_servers: RTCIceServer[] }>("/calls/ice-servers", {
      signal: controller.signal,
    });
    if (res.success && res.data?.ice_servers?.length) {
      return res.data.ice_servers;
    }
  } catch (err) {
    console.warn("[p2p] ICE server fetch threw:", err);
  } finally {
    clearTimeout(timer);
  }
  console.warn("[p2p] ICE server fetch failed/timed out, falling back to STUN-only");
  return FALLBACK_ICE_SERVERS;
}
