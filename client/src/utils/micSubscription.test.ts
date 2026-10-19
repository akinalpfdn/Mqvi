import { describe, it, expect, vi } from "vitest";
import { Track } from "livekit-client";
import { applyMicSubscriptions, shouldReceiveMic, silencedMicsKey } from "./micSubscription";

// A mic played at volume 0 still plays for about a second on every join (see the module). These pin
// that a silenced mic is never received at all, and that an audible one always is.

const base = { isDeafened: false, isServerDeafened: false, masterVolume: 100, userVolumes: {} };

describe("shouldReceiveMic", () => {
  it("should receive someone at the default volume", () => {
    expect(shouldReceiveMic(base, "u1")).toBe(true);
  });

  it("should not receive someone muted for us", () => {
    expect(shouldReceiveMic({ ...base, userVolumes: { u1: 0 } }, "u1")).toBe(false);
  });

  it("should still receive everyone else while one person is muted", () => {
    expect(shouldReceiveMic({ ...base, userVolumes: { u1: 0 } }, "u2")).toBe(true);
  });

  it("should receive someone turned down but not off", () => {
    expect(shouldReceiveMic({ ...base, userVolumes: { u1: 5 } }, "u1")).toBe(true);
  });

  it.each([
    ["deafened", { isDeafened: true }],
    ["server-deafened", { isServerDeafened: true }],
    ["master at 0", { masterVolume: 0 }],
  ])("should receive no one when %s", (_label, override) => {
    expect(shouldReceiveMic({ ...base, ...override }, "u1")).toBe(false);
  });
});

function participant(identity: string) {
  const mic = { source: Track.Source.Microphone, setSubscribed: vi.fn() };
  const screen = { source: Track.Source.ScreenShare, setSubscribed: vi.fn() };
  return { identity, mic, screen, trackPublications: new Map([["m", mic], ["s", screen]]) };
}

describe("applyMicSubscriptions", () => {
  it("should drop the muted person's mic and keep everyone else's", () => {
    const muted = participant("u1");
    const other = participant("u2");

    applyMicSubscriptions([muted, other], { ...base, userVolumes: { u1: 0 } });

    expect(muted.mic.setSubscribed).toHaveBeenCalledWith(false);
    expect(other.mic.setSubscribed).toHaveBeenCalledWith(true);
  });

  // Screen shares follow the viewer's own opt-in, decided elsewhere; muting someone's voice must
  // not touch whether their stream is being watched.
  it("should leave screen shares alone", () => {
    const p = participant("u1");
    applyMicSubscriptions([p], { ...base, userVolumes: { u1: 0 } });
    expect(p.screen.setSubscribed).not.toHaveBeenCalled();
  });
});

describe("silencedMicsKey", () => {
  // The sync re-runs when this changes, and each run is a signal message per participant.
  it("should not change while a volume slider moves above zero", () => {
    expect(silencedMicsKey({ u1: 40 })).toBe(silencedMicsKey({ u1: 90 }));
  });

  it("should change when someone is muted or unmuted", () => {
    expect(silencedMicsKey({ u1: 0 })).not.toBe(silencedMicsKey({ u1: 50 }));
  });

  it("should not depend on the order volumes were set in", () => {
    expect(silencedMicsKey({ a: 0, b: 0 })).toBe(silencedMicsKey({ b: 0, a: 0 }));
  });
});
