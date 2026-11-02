/**
 * A voice join that never reaches the voice server must reach the server log on its own; one that
 * connects, is left, or only shows the abort every join makes must not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { VOICE_CONNECT_TIMEOUT_MS, watchVoiceConnect } from "./voiceConnectWatch";

function harness(roomConnected = false) {
  const report = vi.fn();
  const state = { roomConnected };
  const watch = watchVoiceConnect({
    isRoomConnected: () => state.roomConnected,
    report,
    context: () => ({ serverUrl: "wss://lk.example.net?access_token=secret", e2ee: true, online: true }),
  });
  return { watch, report, state };
}

function error(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watchVoiceConnect", () => {
  it("should report a join that has not connected when the time runs out", () => {
    const { watch, report } = harness();
    watch.failed(error("ConnectionError", "could not establish signal connection: timeout"));

    vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS);

    expect(report).toHaveBeenCalledTimes(1);
    const detail = report.mock.calls[0][0] as string;
    expect(detail).toContain("last error: ConnectionError: could not establish signal connection: timeout");
    expect(detail).toContain("server: lk.example.net");
    expect(detail).not.toContain("secret");
  });

  it("should not report a join that connected", () => {
    const { watch, report } = harness();
    vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS / 2);

    watch.connected();
    vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS);

    expect(report).not.toHaveBeenCalled();
  });

  it("should not report a join the user left", () => {
    const { watch, report } = harness();

    watch.cancel();
    vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS);

    expect(report).not.toHaveBeenCalled();
  });

  // Every join aborts its first connect itself; that must never stand as the reason it failed.
  it("should keep the real error, not the abort every join makes", () => {
    const { watch, report } = harness();
    watch.failed(error("ConnectionError", "could not establish pc connection"));
    watch.failed(error("ConnectionError", "Client initiated disconnect"));

    vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS);

    expect(report.mock.calls[0][0]).toContain("last error: ConnectionError: could not establish pc connection");
  });

  // LiveKit's connect does nothing on a room that is already connected, so no Connected event follows.
  it("should not report when the room is connected under an earlier token", () => {
    const { report } = harness(true);

    vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS);

    expect(report).not.toHaveBeenCalled();
  });

  it("should report once", () => {
    const { watch, report } = harness();
    vi.advanceTimersByTime(VOICE_CONNECT_TIMEOUT_MS * 3);
    watch.failed(error("ConnectionError", "late"));

    expect(report).toHaveBeenCalledTimes(1);
  });
});
