import { describe, it, expect, beforeEach } from "vitest";

import { rememberAudioDevices, savedDeviceStatus, SEEN_MAX } from "./savedAudioDevice";

function device(kind: MediaDeviceKind, deviceId: string): MediaDeviceInfo {
  return { kind, deviceId, groupId: "", label: "", toJSON: () => ({}) };
}

const enumerate = (...devices: MediaDeviceInfo[]) => () => Promise.resolve(devices);

beforeEach(() => {
  localStorage.clear();
});

describe("savedDeviceStatus", () => {
  it("should find a saved speaker that is plugged in", async () => {
    const status = await savedDeviceStatus("audiooutput", "headset", enumerate(device("audiooutput", "default"), device("audiooutput", "headset")));

    expect(status).toBe("present");
  });

  // The user's flow: the app opens with the headset off and must wait for it, not forget it.
  it("should call a speaker this machine has listed before missing once it is unplugged", async () => {
    await savedDeviceStatus("audiooutput", "headset", enumerate(device("audiooutput", "default"), device("audiooutput", "headset")));

    const status = await savedDeviceStatus("audiooutput", "headset", enumerate(device("audiooutput", "default")));

    expect(status).toBe("missing");
  });

  // An id synced from another machine: hashed for that machine, so it never shows up here.
  it("should call a speaker never listed on this machine foreign", async () => {
    const status = await savedDeviceStatus("audiooutput", "pc-headset", enumerate(device("audiooutput", "default"), device("audiooutput", "speakers")));

    expect(status).toBe("foreign");
  });

  it("should report a foreign speaker present once it does show up", async () => {
    await savedDeviceStatus("audiooutput", "headset", enumerate(device("audiooutput", "default")));

    const status = await savedDeviceStatus("audiooutput", "headset", enumerate(device("audiooutput", "default"), device("audiooutput", "headset")));

    expect(status).toBe("present");
  });

  it("should not mistake a microphone with the same id for the speaker", async () => {
    await savedDeviceStatus("audioinput", "headset", enumerate(device("audioinput", "headset")));

    const status = await savedDeviceStatus("audiooutput", "headset", enumerate(device("audioinput", "headset"), device("audiooutput", "default")));

    expect(status).toBe("foreign");
  });

  it("should treat microphones the same way", async () => {
    await savedDeviceStatus("audioinput", "headset-mic", enumerate(device("audioinput", "headset-mic")));

    expect(await savedDeviceStatus("audioinput", "headset-mic", enumerate(device("audioinput", "default")))).toBe("missing");
  });

  // Without media permission every id is empty; "missing" then would warn about a speaker that is there.
  it("should not know when the browser hides device ids", async () => {
    const status = await savedDeviceStatus("audiooutput", "headset", enumerate(device("audiooutput", ""), device("audiooutput", "")));

    expect(status).toBe("unknown");
  });

  it("should not remember anything while the browser hides device ids", async () => {
    await savedDeviceStatus("audiooutput", "headset", enumerate(device("audiooutput", "")));

    expect(await savedDeviceStatus("audiooutput", "headset", enumerate(device("audiooutput", "default")))).toBe("foreign");
  });
});

describe("rememberAudioDevices", () => {
  // A device picked in settings is plugged in at that moment, even if no voice session listed it.
  it("should make a remembered device missing rather than foreign when it is gone", async () => {
    rememberAudioDevices([{ kind: "audiooutput", deviceId: "headset" }]);

    expect(await savedDeviceStatus("audiooutput", "headset", enumerate(device("audiooutput", "default")))).toBe("missing");
  });

  it("should ignore video devices and empty ids", async () => {
    rememberAudioDevices([{ kind: "videoinput", deviceId: "cam" }, { kind: "audiooutput", deviceId: "" }]);

    expect(localStorage.getItem("mqvi_seen_audio_devices")).toBeNull();
  });

  it("should forget the oldest devices past the cap", async () => {
    rememberAudioDevices([{ kind: "audiooutput", deviceId: "oldest" }]);
    rememberAudioDevices(Array.from({ length: SEEN_MAX }, (_, i) => ({ kind: "audiooutput" as const, deviceId: `d${i}` })));

    expect(await savedDeviceStatus("audiooutput", "oldest", enumerate(device("audiooutput", "default")))).toBe("foreign");
    expect(await savedDeviceStatus("audiooutput", `d${SEEN_MAX - 1}`, enumerate(device("audiooutput", "default")))).toBe("missing");
  });

  it("should survive a corrupt record", async () => {
    localStorage.setItem("mqvi_seen_audio_devices", "{not json");

    rememberAudioDevices([{ kind: "audiooutput", deviceId: "headset" }]);

    expect(await savedDeviceStatus("audiooutput", "headset", enumerate(device("audiooutput", "default")))).toBe("missing");
  });
});
