/**
 * Runs the hook against LiveKit's real Room and LocalAudioTrack. The browser is faked underneath
 * them: the device list, `devicechange`, and getUserMedia with the spec's deviceId rules (a plain
 * id is a preference and falls back to another mic; `exact` fails when the mic is gone).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { ConnectionState, LocalAudioTrack, Room, RoomEvent, Track } from "livekit-client";
import type { LocalTrackPublication } from "livekit-client";

import { useSavedAudioDevices } from "./useSavedAudioDevices";
import { rememberAudioDevices } from "../utils/savedAudioDevice";
import { useToastStore } from "../stores/toastStore";

// ─── Fake browser ───

let devices: MediaDeviceInfo[] = [];
let deviceChangeListeners: Array<() => void> = [];
const getUserMedia = vi.fn();

function device(kind: MediaDeviceKind, deviceId: string, groupId = `${deviceId}-group`): MediaDeviceInfo {
  return { kind, deviceId, groupId, label: deviceId, toJSON: () => ({}) };
}

// As Chrome lists them: "default" first, sharing its group with the device behind it.
const BUILTIN = [
  device("audiooutput", "default", "speakers-group"),
  device("audiooutput", "speakers", "speakers-group"),
  device("audioinput", "default", "builtin-mic-group"),
  device("audioinput", "builtin-mic", "builtin-mic-group"),
];

/** Electron's user agent: LiveKit's device-change handling differs on Safari, which jsdom's resembles. */
const ELECTRON_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) mqvi/2.0.0 Chrome/138.0.7204.97 Electron/37.2.0 Safari/537.36";
const HEADSET = [device("audiooutput", "headset"), device("audioinput", "headset-mic")];

function plugIn(...added: MediaDeviceInfo[]) {
  devices = [...devices, ...added];
  deviceChangeListeners.forEach((fn) => fn());
}

function unplug(...ids: string[]) {
  devices = devices.filter((d) => !ids.includes(d.deviceId));
  deviceChangeListeners.forEach((fn) => fn());
}

type FakeTrack = MediaStreamTrack & { readyState: MediaStreamTrackState };

function fakeMic(deviceId: string, constraints: MediaTrackConstraints): FakeTrack {
  const track = {
    kind: "audio",
    id: `mic-${deviceId}-${Math.random()}`,
    enabled: true,
    muted: false,
    readyState: "live" as MediaStreamTrackState,
    getSettings: () => ({ deviceId }),
    getConstraints: () => constraints,
    applyConstraints: async () => {},
    stop() {
      track.readyState = "ended";
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  // Only the members LiveKit's LocalTrack touches are implemented.
  return track as unknown as FakeTrack;
}

/** getUserMedia's deviceId rule: exact must match, a plain id is preferred and otherwise falls back. */
function grantMic(constraints: MediaStreamConstraints) {
  const audio = (typeof constraints.audio === "object" ? constraints.audio : {}) as MediaTrackConstraints;
  const requested = audio.deviceId;
  const mics = devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "default");
  let chosen: string | undefined;
  if (requested && typeof requested === "object" && "exact" in requested) {
    chosen = mics.find((d) => d.deviceId === requested.exact)?.deviceId;
    if (!chosen) return Promise.reject(new DOMException("exact device gone", "OverconstrainedError"));
  } else {
    const wanted = typeof requested === "string" ? requested : undefined;
    chosen = mics.find((d) => d.deviceId === wanted)?.deviceId ?? mics[0]?.deviceId;
  }
  const track = fakeMic(chosen ?? "none", audio);
  return Promise.resolve({ getTracks: () => [track] });
}

class FakeMediaStream {
  private tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

beforeEach(() => {
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  devices = [...BUILTIN];
  deviceChangeListeners = [];
  getUserMedia.mockReset().mockImplementation(grantMic);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: ELECTRON_UA });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: () => Promise.resolve([...devices]),
      getUserMedia,
      addEventListener: (type: string, fn: () => void) => {
        if (type === "devicechange") deviceChangeListeners.push(fn);
      },
      removeEventListener: (type: string, fn: () => void) => {
        if (type === "devicechange") deviceChangeListeners = deviceChangeListeners.filter((l) => l !== fn);
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A LiveKit room in the state a live call has, constructed after the fake browser is in place. */
function connectedRoom(): Room {
  const room = new Room({ webAudioMix: true });
  room.state = ConnectionState.Connected;
  return room;
}

/** Publishes a real LocalAudioTrack as the room's microphone, captured from deviceId. */
function publishMic(room: Room, deviceId: string): LocalAudioTrack {
  const constraints: MediaTrackConstraints = { deviceId, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const track = new LocalAudioTrack(fakeMic(deviceId, constraints), constraints, false);
  track.source = Track.Source.Microphone;
  // The room only reads source and track from a publication here; a real one needs a server's TrackInfo.
  const publication = { source: Track.Source.Microphone, track, audioTrack: track } as unknown as LocalTrackPublication;
  room.localParticipant.trackPublications.set("mic", publication);
  room.localParticipant.audioTrackPublications.set("mic", publication);
  return track;
}

const warnings = () => useToastStore.getState().toasts.filter((t) => t.type === "warning");

// ─── Speaker ───

describe("useSavedAudioDevices — speaker", () => {
  it("should play on the saved speaker when the call starts with it plugged in", async () => {
    devices = [...BUILTIN, ...HEADSET];
    const room = connectedRoom();

    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "", "headset"));

    await waitFor(() => expect(room.getActiveDevice("audiooutput")).toBe("headset"));
  });

  // The PC flow: the app opens with the headset off, and the headset is switched on mid-call.
  it("should move to the saved speaker when it is plugged in after the call started", async () => {
    rememberAudioDevices([device("audiooutput", "headset")]);
    const room = connectedRoom();
    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "", "headset"));
    await waitFor(() => expect(warnings()).toHaveLength(1));

    plugIn(...HEADSET);

    await waitFor(() => expect(room.getActiveDevice("audiooutput")).toBe("headset"));
  });

  // What LiveKit does on its own, with no hook: it starts on "default" and does not move to a
  // speaker plugged in later — getting back on the headset is this hook's job.
  it("should show LiveKit itself staying on the default output when a speaker is plugged in", async () => {
    const room = connectedRoom();
    expect(room.getActiveDevice("audiooutput")).toBe("default");

    plugIn(...HEADSET);
    await new Promise((r) => setTimeout(r, 20));

    expect(room.getActiveDevice("audiooutput")).toBe("default");
  });

  // ...and it does move off a speaker that is unplugged, which the hook leaves to it.
  it("should show LiveKit itself moving off a speaker that is unplugged", async () => {
    devices = [...BUILTIN, ...HEADSET];
    const room = connectedRoom();
    await room.switchActiveDevice("audiooutput", "headset");

    unplug("headset", "headset-mic");

    await waitFor(() => expect(room.getActiveDevice("audiooutput")).toBe("speakers"));
  });

  it("should leave LiveKit on the default output when the saved speaker is unplugged mid-call", async () => {
    devices = [...BUILTIN, ...HEADSET];
    const room = connectedRoom();
    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "", "headset"));
    await waitFor(() => expect(room.getActiveDevice("audiooutput")).toBe("headset"));

    unplug("headset", "headset-mic");

    await waitFor(() => expect(warnings()).toHaveLength(1));
    await waitFor(() => expect(room.getActiveDevice("audiooutput")).not.toBe("headset"));
  });

  it("should come back to the saved speaker after it is unplugged and plugged in again", async () => {
    devices = [...BUILTIN, ...HEADSET];
    const room = connectedRoom();
    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "", "headset"));
    await waitFor(() => expect(room.getActiveDevice("audiooutput")).toBe("headset"));
    unplug("headset", "headset-mic");
    await waitFor(() => expect(room.getActiveDevice("audiooutput")).not.toBe("headset"));

    plugIn(...HEADSET);

    await waitFor(() => expect(room.getActiveDevice("audiooutput")).toBe("headset"));
  });

  // The bug: the PC's headset id synced to the Mac warned that it was not connected.
  it("should neither warn about nor use a speaker this machine never had", async () => {
    const room = connectedRoom();
    const switchSpy = vi.spyOn(room, "switchActiveDevice");

    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "", "pc-headset"));
    plugIn(device("audiooutput", "airplay"));

    await waitFor(() => expect(deviceChangeListeners.length).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(warnings()).toHaveLength(0);
    expect(switchSpy.mock.calls.filter(([, id]) => id === "pc-headset")).toHaveLength(0);
  });

  it("should warn only once while the saved speaker stays unplugged", async () => {
    rememberAudioDevices([device("audiooutput", "headset")]);
    const room = connectedRoom();
    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "", "headset"));
    await waitFor(() => expect(warnings()).toHaveLength(1));

    plugIn(device("audiooutput", "airplay"));
    room.emit(RoomEvent.Reconnected);
    await new Promise((r) => setTimeout(r, 20));

    expect(warnings()).toHaveLength(1);
  });

  it("should stop following device changes once the call ends", async () => {
    rememberAudioDevices([device("audiooutput", "headset")]);
    const room = connectedRoom();
    const { unmount } = renderHook(() => useSavedAudioDevices(room, room.localParticipant, "", "headset"));
    await waitFor(() => expect(warnings()).toHaveLength(1));

    unmount();
    plugIn(...HEADSET);
    await new Promise((r) => setTimeout(r, 20));

    expect(room.getActiveDevice("audiooutput")).not.toBe("headset");
  });
});

// ─── Microphone ───

describe("useSavedAudioDevices — microphone", () => {
  it("should move the call's mic to the saved one when it is plugged in after the call started", async () => {
    rememberAudioDevices([device("audioinput", "headset-mic")]);
    const room = connectedRoom();
    const track = publishMic(room, "builtin-mic");
    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "headset-mic", ""));

    plugIn(...HEADSET);

    await waitFor(async () => expect(await track.getDeviceId(false)).toBe("headset-mic"));
  });

  // The restart keeps the call's processing constraints and asks for the device as a preference.
  it("should ask for the saved mic without exact and keep the call's audio processing", async () => {
    const room = connectedRoom();
    publishMic(room, "builtin-mic");
    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "headset-mic", ""));

    plugIn(...HEADSET);

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    const audio = getUserMedia.mock.calls[0][0].audio as MediaTrackConstraints;
    expect(audio.deviceId).toBe("headset-mic");
    expect(audio).toMatchObject({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  });

  // Why not exact: after the switch the mic's constraint names the headset. If the headset goes
  // while the user is muted (or idle on push-to-talk), LiveKit restarts the mic on unmute with that
  // constraint. Exact would fail there and leave them without a mic.
  it("should still get a mic on unmute when the saved one was unplugged while muted", async () => {
    const room = connectedRoom();
    const track = publishMic(room, "builtin-mic");
    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "headset-mic", ""));
    plugIn(...HEADSET);
    await waitFor(async () => expect(await track.getDeviceId(false)).toBe("headset-mic"));

    await track.mute();
    unplug("headset", "headset-mic");
    (track.mediaStreamTrack as FakeTrack).readyState = "ended";
    await track.unmute();

    expect(await track.getDeviceId(false)).toBe("builtin-mic");
    expect(track.isMuted).toBe(false);
  });

  it("should leave a mic that is already on the saved device alone", async () => {
    devices = [...BUILTIN, ...HEADSET];
    const room = connectedRoom();
    publishMic(room, "headset-mic");

    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "headset-mic", ""));
    plugIn(device("audiooutput", "airplay"));
    await new Promise((r) => setTimeout(r, 20));

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("should not touch the mic for a saved mic this machine never had", async () => {
    const room = connectedRoom();
    publishMic(room, "builtin-mic");

    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "pc-mic", ""));
    plugIn(device("audioinput", "usb-mic"));
    await new Promise((r) => setTimeout(r, 20));

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("should leave a mic that follows the OS default to the OS", async () => {
    const room = connectedRoom();
    publishMic(room, "builtin-mic");

    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "default", ""));
    plugIn(...HEADSET);
    await new Promise((r) => setTimeout(r, 20));

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  // Muted (or push-to-talk idle): LiveKit records the change and applies it on the next unmute.
  it("should put a muted mic on the saved device when it is next unmuted", async () => {
    const room = connectedRoom();
    const track = publishMic(room, "builtin-mic");
    await track.mute();
    renderHook(() => useSavedAudioDevices(room, room.localParticipant, "headset-mic", ""));

    plugIn(...HEADSET);
    await new Promise((r) => setTimeout(r, 20));
    expect(getUserMedia).not.toHaveBeenCalled();
    await track.unmute();

    expect(await track.getDeviceId(false)).toBe("headset-mic");
  });
});
