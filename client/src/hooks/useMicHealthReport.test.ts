/** Reading the mic: the right track, and the right platform. */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@capacitor/app", () => ({ App: { getInfo: vi.fn() } }));

import { micPlatform, readMicProbe } from "./useMicHealthReport";
import type { LocalTrackPublication } from "livekit-client";

const mediaTrack = (over: Partial<MediaStreamTrack> = {}) =>
  ({ readyState: "live", muted: false, enabled: true, ...over }) as MediaStreamTrack;

const publication = (output: MediaStreamTrack, over: Record<string, unknown> = {}) =>
  ({ track: { mediaStreamTrack: output, isMuted: false, isUpstreamPaused: false, ...over } }) as unknown as LocalTrackPublication;

describe("readMicProbe", () => {
  // With a processor attached LiveKit's mediaStreamTrack is the processor's output. The OS mutes and
  // ends the raw capture track — reading the output would miss exactly the screen-lock case.
  it("should watch the raw capture track, not the processor output", () => {
    const output = mediaTrack();
    const capture = mediaTrack({ muted: true });
    const ctx = { state: "running" } as BaseAudioContext;
    const probe = readMicProbe(publication(output), true, "live", { captureTrack: capture, audioContext: ctx, processedTrack: output });

    expect(probe.capture).toBe(capture);
    expect(probe.snapshot.osMuted).toBe(true);
    expect(probe.snapshot.contextState).toBe("running");
  });

  it("should use the track itself when no processor is attached", () => {
    const probe = readMicProbe(publication(mediaTrack({ readyState: "ended" })), true, "live", null);
    expect(probe.snapshot.trackEnded).toBe(true);
    expect(probe.snapshot.contextState).toBeNull();
  });

  it("should read LiveKit's own mute and upstream pause", () => {
    const probe = readMicProbe(publication(mediaTrack(), { isMuted: true, isUpstreamPaused: true }), true, "live", null);
    expect(probe.snapshot.sdkMuted).toBe(true);
    expect(probe.snapshot.upstreamPaused).toBe(true);
  });

  it("should report no publication when nothing is published", () => {
    expect(readMicProbe(undefined, true, "live", null).snapshot.hasPublication).toBe(false);
  });
});

describe("micPlatform", () => {
  afterEach(() => {
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it("should name the desktop OS from the Electron preload", () => {
    for (const [platform, want] of [["darwin", "electron_mac"], ["win32", "electron_windows"], ["linux", "electron_linux"]]) {
      (window as { electronAPI?: unknown }).electronAPI = { platform };
      expect(micPlatform()).toBe(want);
    }
  });

  it("should be web in a browser", () => {
    expect(micPlatform()).toBe("web");
  });
});
