/** When a mic counts as dead, what is reported, and how often. */
import { describe, it, expect } from "vitest";
import { MicHealthTracker, MIC_MAX_EPISODES, MIC_OPEN_AFTER_MS, micFault } from "./micHealth";
import type { MicSnapshot } from "./micHealth";

const healthy: MicSnapshot = {
  connected: true, intent: "live", hasPublication: true, trackEnded: false, osMuted: false,
  sdkMuted: false, upstreamPaused: false, trackDisabled: false, contextState: null, processedTrackEnded: false,
};
const snap = (over: Partial<MicSnapshot>): MicSnapshot => ({ ...healthy, ...over });

describe("micFault", () => {
  it("should report nothing for a working mic, a muted user, or a room that is reconnecting", () => {
    expect(micFault(healthy)).toBeNull();
    expect(micFault(snap({ intent: "off", trackEnded: true }))).toBeNull();
    expect(micFault(snap({ connected: false, trackEnded: true }))).toBeNull();
  });

  it("should name the deepest cause when several hold", () => {
    expect(micFault(snap({ trackEnded: true, sdkMuted: true, osMuted: true }))).toBe("track_ended");
    expect(micFault(snap({ upstreamPaused: true, osMuted: true }))).toBe("upstream_paused");
    expect(micFault(snap({ sdkMuted: true, upstreamPaused: true }))).toBe("sdk_muted");
    expect(micFault(snap({ osMuted: true, trackDisabled: true }))).toBe("os_muted");
    expect(micFault(snap({ hasPublication: false }))).toBe("no_publication");
    expect(micFault(snap({ contextState: "suspended" }))).toBe("audio_context_suspended");
    expect(micFault(snap({ contextState: "running", processedTrackEnded: true }))).toBe("processed_track_ended");
  });

  // Between presses the track is muted on purpose and may not even be published yet.
  it("should judge push to talk on capture faults only", () => {
    expect(micFault(snap({ intent: "ptt", sdkMuted: true, trackDisabled: true }))).toBeNull();
    expect(micFault(snap({ intent: "ptt", hasPublication: false }))).toBeNull();
    expect(micFault(snap({ intent: "ptt", sdkMuted: true, osMuted: true }))).toBe("os_muted");
    expect(micFault(snap({ intent: "ptt", sdkMuted: true, trackEnded: true }))).toBe("track_ended");
    expect(micFault(snap({ intent: "ptt", contextState: "suspended" }))).toBe("audio_context_suspended");
  });
});

describe("MicHealthTracker", () => {
  it("should report nothing for a fault shorter than the open threshold", () => {
    const t = new MicHealthTracker();
    expect(t.evaluate(snap({ osMuted: true }), 0)).toBeNull();
    expect(t.evaluate(snap({ osMuted: true }), MIC_OPEN_AFTER_MS - 1)).toBeNull();
    expect(t.evaluate(healthy, MIC_OPEN_AFTER_MS + 1)).toBeNull();
    expect(t.leave(MIC_OPEN_AFTER_MS + 2)).toBeNull();
  });

  it("should open once with the cause, the causes seen, and the trail", () => {
    const t = new MicHealthTracker();
    t.note("reconnected", 1_000);
    t.note("screen_locked", 2_000);
    t.evaluate(snap({ osMuted: true }), 3_000);
    t.note("upstream_paused", 8_000);
    const dead = t.evaluate(snap({ osMuted: true, upstreamPaused: true }), 3_000 + MIC_OPEN_AFTER_MS);

    expect(dead).toMatchObject({
      event: "dead", fault: "upstream_paused", faults: ["os_muted", "upstream_paused"],
      intent: "live", durationMs: MIC_OPEN_AFTER_MS, sinceReconnectMs: 2_000,
    });
    expect(dead?.trail).toEqual([
      { e: "reconnected", ago_ms: 10_000 },
      { e: "screen_locked", ago_ms: 9_000 },
      { e: "upstream_paused", ago_ms: 3_000 },
    ]);
    // Still dead: no second report.
    expect(t.evaluate(snap({ upstreamPaused: true }), 20_000)).toBeNull();
  });

  it("should close as recovered once the mic works again, with the whole duration", () => {
    const t = new MicHealthTracker();
    t.evaluate(snap({ sdkMuted: true }), 0);
    t.evaluate(snap({ sdkMuted: true }), MIC_OPEN_AFTER_MS);
    const closed = t.evaluate(healthy, 30_000);
    expect(closed).toMatchObject({ event: "recovered", fault: "sdk_muted", durationMs: 30_000 });
    expect(t.leave(31_000)).toBeNull();
  });

  // The user muting, or a reconnect, says nothing about whether the mic works.
  it("should keep an episode open across a mute or a reconnect", () => {
    const t = new MicHealthTracker();
    t.evaluate(snap({ trackEnded: true }), 0);
    t.evaluate(snap({ trackEnded: true }), MIC_OPEN_AFTER_MS);
    expect(t.evaluate(snap({ intent: "off" }), 10_000)).toBeNull();
    expect(t.evaluate(snap({ connected: false }), 11_000)).toBeNull();
    expect(t.leave(12_000)).toMatchObject({ event: "left_voice", fault: "track_ended", durationMs: 12_000 });
  });

  it("should add later causes to an open episode", () => {
    const t = new MicHealthTracker();
    t.evaluate(snap({ osMuted: true }), 0);
    t.evaluate(snap({ osMuted: true }), MIC_OPEN_AFTER_MS);
    t.evaluate(snap({ upstreamPaused: true }), 10_000);
    expect(t.leave(11_000)?.faults).toEqual(["os_muted", "upstream_paused"]);
  });

  // A reconnect puts the mic in limbo by design; a fault on each side of it is two short faults.
  it("should restart the clock when the room drops in the middle of a fault", () => {
    const t = new MicHealthTracker();
    t.evaluate(snap({ osMuted: true }), 0);
    t.evaluate(snap({ connected: false }), 5_000);
    t.evaluate(snap({ osMuted: true }), 6_000);
    expect(t.evaluate(snap({ osMuted: true }), 6_000 + MIC_OPEN_AFTER_MS - 1)).toBeNull();
    expect(t.evaluate(snap({ osMuted: true }), 6_000 + MIC_OPEN_AFTER_MS)).not.toBeNull();
  });

  it("should stop opening episodes after the per-session cap", () => {
    const t = new MicHealthTracker();
    let opened = 0;
    let now = 0;
    for (let i = 0; i < MIC_MAX_EPISODES + 3; i++) {
      t.evaluate(snap({ osMuted: true }), now);
      if (t.evaluate(snap({ osMuted: true }), now + MIC_OPEN_AFTER_MS)) opened++;
      t.evaluate(healthy, now + MIC_OPEN_AFTER_MS + 1);
      now += 60_000;
    }
    expect(opened).toBe(MIC_MAX_EPISODES);
  });

  it("should say -1 for since-reconnect when there was none", () => {
    const t = new MicHealthTracker();
    t.evaluate(snap({ osMuted: true }), 0);
    expect(t.evaluate(snap({ osMuted: true }), MIC_OPEN_AFTER_MS)?.sinceReconnectMs).toBe(-1);
  });

  // A push-to-talk user presses all session long; only presses during a fault say anything.
  it("should keep push-to-talk presses only while something is wrong", () => {
    const t = new MicHealthTracker();
    t.note("ptt_down", 0);
    t.note("ptt_up", 100);
    t.evaluate(snap({ intent: "ptt", osMuted: true }), 1_000);
    t.note("ptt_down", 2_000);
    const dead = t.evaluate(snap({ intent: "ptt", osMuted: true }), 1_000 + MIC_OPEN_AFTER_MS);
    expect(dead?.trail.map((x) => x.e)).toEqual(["ptt_down"]);
    expect(dead?.intent).toBe("ptt");
  });

  it("should carry the last device error as detail", () => {
    const t = new MicHealthTracker();
    t.noteDeviceError("NotReadableError: Could not start audio source", 0);
    t.evaluate(snap({ hasPublication: false }), 1_000);
    const dead = t.evaluate(snap({ hasPublication: false }), 1_000 + MIC_OPEN_AFTER_MS);
    expect(dead?.detail).toBe("NotReadableError: Could not start audio source");
    expect(dead?.trail.map((x) => x.e)).toEqual(["device_error"]);
  });

  it("should keep the trail to the last ten minutes and 24 entries", () => {
    const t = new MicHealthTracker();
    t.note("screen_locked", 0);
    for (let i = 0; i < 30; i++) t.note("device_change", 700_000 + i);
    t.evaluate(snap({ osMuted: true }), 700_100);
    const dead = t.evaluate(snap({ osMuted: true }), 700_100 + MIC_OPEN_AFTER_MS);
    expect(dead?.trail).toHaveLength(24);
    expect(dead?.trail.some((x) => x.e === "screen_locked")).toBe(false);
  });
});
