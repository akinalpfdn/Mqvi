/**
 * Puts the call on this machine's saved speaker and microphone, and back on them when they are
 * plugged in after the call started. A saved device that is not plugged in is never handed to
 * LiveKit (see savedDeviceStatus); the user is told once, and only about a device this machine has
 * had: an id from another machine is never coming.
 */

import { useEffect } from "react";
import { RoomEvent, ConnectionState, Track } from "livekit-client";
import type { LocalParticipant, Room } from "livekit-client";
import { savedDeviceStatus } from "../utils/savedAudioDevice";
import { useToastStore } from "../stores/toastStore";
import i18n from "../i18n";

/** Device ids that stand for "whatever the OS uses": LiveKit and the OS move them by themselves. */
function followsOS(deviceId: string): boolean {
  return deviceId === "default" || deviceId === "communications";
}

export function useSavedAudioDevices(room: Room, localParticipant: LocalParticipant, inputDevice: string, outputDevice: string): void {
  // switchActiveDevice stores the speaker on the Room, so tracks that arrive later play on it too.
  // LiveKit moves off a speaker that is unplugged by itself, and never onto one plugged in later.
  useEffect(() => {
    if (!outputDevice) return;
    let cancelled = false;
    let toldMissing = false;

    async function applyOutputDevice() {
      const status = await savedDeviceStatus("audiooutput", outputDevice).catch(() => "unknown" as const);
      if (cancelled) return;
      if (status === "missing" || status === "foreign") {
        if (status === "missing" && !toldMissing) {
          toldMissing = true;
          useToastStore.getState().addToast("warning", i18n.t("voice:outputDeviceMissing"), 8_000);
        }
        return;
      }
      toldMissing = false;
      try {
        await room.switchActiveDevice("audiooutput", outputDevice);
      } catch (err) {
        console.error("[useSavedAudioDevices] Failed to switch output device:", err);
      }
    }

    function applyWhenConnected() {
      if (room.state === ConnectionState.Connected) void applyOutputDevice();
    }

    applyWhenConnected();
    room.on(RoomEvent.Connected, applyWhenConnected);
    room.on(RoomEvent.Reconnected, applyWhenConnected);
    navigator.mediaDevices?.addEventListener("devicechange", applyWhenConnected);

    return () => {
      cancelled = true;
      room.off(RoomEvent.Connected, applyWhenConnected);
      room.off(RoomEvent.Reconnected, applyWhenConnected);
      navigator.mediaDevices?.removeEventListener("devicechange", applyWhenConnected);
    };
  }, [room, outputDevice]);

  // LiveKit leaves a call on the mic it began with. Not exact: a mic that later disappears must
  // restart on the default, not fail. A muted mic takes the change when it is next unmuted.
  useEffect(() => {
    if (!inputDevice || followsOS(inputDevice)) return;
    let cancelled = false;

    async function applyInputDevice() {
      const track = localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      if (!track) return; // not published yet: the capture defaults already ask for this device
      const status = await savedDeviceStatus("audioinput", inputDevice).catch(() => "unknown" as const);
      if (cancelled || status !== "present") return;
      if (cancelled || (await track.getDeviceId(false)) === inputDevice) return;
      try {
        await room.switchActiveDevice("audioinput", inputDevice, false);
      } catch (err) {
        console.error("[useSavedAudioDevices] Failed to switch input device:", err);
      }
    }

    function applyWhenConnected() {
      if (room.state === ConnectionState.Connected) void applyInputDevice();
    }

    applyWhenConnected();
    room.on(RoomEvent.Connected, applyWhenConnected);
    room.on(RoomEvent.Reconnected, applyWhenConnected);
    navigator.mediaDevices?.addEventListener("devicechange", applyWhenConnected);

    return () => {
      cancelled = true;
      room.off(RoomEvent.Connected, applyWhenConnected);
      room.off(RoomEvent.Reconnected, applyWhenConnected);
      navigator.mediaDevices?.removeEventListener("devicechange", applyWhenConnected);
    };
  }, [room, localParticipant, inputDevice]);
}
