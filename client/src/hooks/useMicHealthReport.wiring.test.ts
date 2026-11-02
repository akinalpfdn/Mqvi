/** End to end through the hook: a dead mic reaches the server once, and its ending is reported. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@capacitor/app", () => ({ App: { getInfo: vi.fn() } }));
vi.mock("../api/voice", () => ({ reportMicHealth: vi.fn(() => Promise.resolve({ success: true })) }));

import { reportMicHealth } from "../api/voice";
import { useMicHealthReport } from "./useMicHealthReport";
import { useVoiceStore } from "../stores/voiceStore";
import { MIC_OPEN_AFTER_MS } from "../audio/micHealth";
import type { Room } from "livekit-client";

const sent = vi.mocked(reportMicHealth);

/** The on/off surface the hook uses on LiveKit's Room and LocalTrack. */
class Emitter {
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  on(event: string, fn: (...args: unknown[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)?.add(fn);
    return this;
  }
  off(event: string, fn: (...args: unknown[]) => void) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }
}

/** A capture track that can fire the OS mute event. */
function captureTrack() {
  const target = new EventTarget() as EventTarget & { readyState: string; muted: boolean; enabled: boolean };
  Object.assign(target, { readyState: "live", muted: false, enabled: true });
  return target;
}

function fakeRoom(capture: ReturnType<typeof captureTrack>) {
  const track = Object.assign(new Emitter(), { mediaStreamTrack: capture, isMuted: false, isUpstreamPaused: false });
  const room = Object.assign(new Emitter(), {
    state: "connected",
    localParticipant: { getTrackPublication: () => ({ track }) },
  });
  return { room: room as unknown as Room, track };
}

describe("useMicHealthReport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sent.mockClear();
    useVoiceStore.setState({
      currentVoiceServerId: "srv1", currentVoiceChannelId: "vc1",
      isMuted: false, isServerMuted: false, inputMode: "voice_activity",
    });
  });
  afterEach(() => vi.useRealTimers());

  it("should send one dead report after the threshold, then left_voice to the same channel on leave", () => {
    const capture = captureTrack();
    const { room } = fakeRoom(capture);
    const hook = renderHook(() => useMicHealthReport(room, () => null, () => "none"));

    capture.muted = true;
    capture.dispatchEvent(new Event("mute"));
    vi.advanceTimersByTime(MIC_OPEN_AFTER_MS + 2_100);

    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0]).toBe("srv1");
    expect(sent.mock.calls[0][1]).toMatchObject({
      event: "dead", fault: "os_muted", channel_id: "vc1", platform: "web", processor: "none", intent: "live",
    });
    expect(sent.mock.calls[0][1].trail.map((t) => t.e)).toContain("os_muted");

    vi.advanceTimersByTime(30_000);
    expect(sent).toHaveBeenCalledTimes(1); // still dead, nothing more

    // Leaving voice clears the store before the component unmounts.
    useVoiceStore.setState({ currentVoiceServerId: null, currentVoiceChannelId: null });
    hook.unmount();

    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1][0]).toBe("srv1");
    expect(sent.mock.calls[1][1]).toMatchObject({ event: "left_voice", fault: "os_muted", channel_id: "vc1" });
  });

  it("should report recovery when the OS gives the mic back", () => {
    const capture = captureTrack();
    const { room } = fakeRoom(capture);
    renderHook(() => useMicHealthReport(room, () => null, () => "none"));

    capture.muted = true;
    capture.dispatchEvent(new Event("mute"));
    vi.advanceTimersByTime(MIC_OPEN_AFTER_MS + 2_100);
    capture.muted = false;
    capture.dispatchEvent(new Event("unmute"));

    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1][1]).toMatchObject({ event: "recovered", fault: "os_muted" });
  });

  it("should send nothing for a healthy session or a short glitch", () => {
    const capture = captureTrack();
    const { room } = fakeRoom(capture);
    const hook = renderHook(() => useMicHealthReport(room, () => null, () => "none"));

    capture.muted = true;
    capture.dispatchEvent(new Event("mute"));
    vi.advanceTimersByTime(4_000);
    capture.muted = false;
    capture.dispatchEvent(new Event("unmute"));
    vi.advanceTimersByTime(60_000);
    hook.unmount();

    expect(sent).not.toHaveBeenCalled();
  });

  it("should not judge a user who muted themselves", () => {
    useVoiceStore.setState({ isMuted: true });
    const capture = captureTrack();
    const { room, track } = fakeRoom(capture);
    track.isMuted = true;
    capture.enabled = false;
    renderHook(() => useMicHealthReport(room, () => null, () => "none"));

    vi.advanceTimersByTime(60_000);
    expect(sent).not.toHaveBeenCalled();
  });
});
