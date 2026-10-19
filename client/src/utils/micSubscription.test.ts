import { describe, it, expect } from "vitest";
import { shouldReceiveMic } from "./micSubscription";

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
