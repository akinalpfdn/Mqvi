/** Reading the mic: the right track, and the right platform. */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@capacitor/app", () => ({ App: { getInfo: vi.fn() } }));

import { currentMicIntent, mayPublishMic, micPlatform, readMicProbe } from "./useMicHealthReport";
import { MicHealthTracker } from "../audio/micHealth";
import { useVoiceStore } from "../stores/voiceStore";
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

// A member without Speak gets a token with canPublish=false and LiveKit refuses the publish. That is
// not a dead mic; reporting it wrote two WARN rows for every join to a listen-only channel.
describe("mic intent and the token's publish permission", () => {
  const MICROPHONE = 2;
  const CAMERA = 1;
  const SCREEN_SHARE = 3;

  afterEach(() => {
    useVoiceStore.setState({ isMuted: false, isServerMuted: false, inputMode: "voice_activity" });
  });

  it("should allow the mic when the token may publish anything", () => {
    expect(mayPublishMic({ canPublish: true, canPublishSources: [] })).toBe(true);
  });

  it("should not allow the mic without publish permission", () => {
    expect(mayPublishMic({ canPublish: false, canPublishSources: [] })).toBe(false);
  });

  // A server mute baked into the token: everything but the mic.
  it("should not allow the mic when the sources leave it out", () => {
    expect(mayPublishMic({ canPublish: true, canPublishSources: [CAMERA, SCREEN_SHARE] })).toBe(false);
  });

  it("should allow the mic when the sources name it", () => {
    expect(mayPublishMic({ canPublish: true, canPublishSources: [MICROPHONE, SCREEN_SHARE] })).toBe(true);
  });

  it("should not judge before the room has said anything", () => {
    expect(mayPublishMic(undefined)).toBe(true);
  });

  it("should count a live mic without publish permission as off", () => {
    useVoiceStore.setState({ isMuted: false, isServerMuted: false, inputMode: "voice_activity" });

    expect(currentMicIntent({ canPublish: false, canPublishSources: [] })).toBe("off");
  });

  it("should keep a live mic live when it may publish", () => {
    useVoiceStore.setState({ isMuted: false, isServerMuted: false, inputMode: "voice_activity" });

    expect(currentMicIntent({ canPublish: true, canPublishSources: [] })).toBe("live");
  });

  it("should write nothing for a listen-only member who stays in the call", () => {
    useVoiceStore.setState({ isMuted: false, isServerMuted: false, inputMode: "voice_activity" });
    const tracker = new MicHealthTracker();
    const reports: unknown[] = [];

    for (let t = 0; t <= 60_000; t += 2_000) {
      const intent = currentMicIntent({ canPublish: false, canPublishSources: [] });
      const report = tracker.evaluate(readMicProbe(undefined, true, intent, null).snapshot, t);
      if (report) reports.push(report);
    }
    const closing = tracker.leave(60_000);

    expect(reports).toEqual([]);
    expect(closing).toBeNull();
  });
});
