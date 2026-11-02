import { describe, it, expect } from "vitest";

import { outputDeviceAvailable } from "./outputDevice";

function device(kind: MediaDeviceKind, deviceId: string): MediaDeviceInfo {
  return { kind, deviceId, groupId: "", label: "", toJSON: () => ({}) };
}

const enumerate = (...devices: MediaDeviceInfo[]) => () => Promise.resolve(devices);

describe("outputDeviceAvailable", () => {
  it("should find a saved speaker that is plugged in", async () => {
    expect(await outputDeviceAvailable("headset", enumerate(device("audiooutput", "default"), device("audiooutput", "headset")))).toBe(true);
  });

  it("should report a saved speaker that was unplugged", async () => {
    expect(await outputDeviceAvailable("headset", enumerate(device("audiooutput", "default"), device("audiooutput", "speakers")))).toBe(false);
  });

  it("should not mistake a microphone with the same id for the speaker", async () => {
    expect(await outputDeviceAvailable("headset", enumerate(device("audioinput", "headset"), device("audiooutput", "default")))).toBe(false);
  });

  // Without media permission every id is empty; "missing" then would warn about a speaker that is there.
  it("should not know when the browser hides device ids", async () => {
    expect(await outputDeviceAvailable("headset", enumerate(device("audiooutput", ""), device("audiooutput", "")))).toBeNull();
  });
});
