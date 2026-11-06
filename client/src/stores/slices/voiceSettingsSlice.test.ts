import { describe, it, expect, vi } from "vitest";
import {
  isMouseBinding,
  DOM_BUTTON_TO_MOUSE_TOKEN,
  migrateSettings,
  DEFAULT_SETTINGS,
  settingsForServer,
  mergeServerSettings,
} from "./voiceSettingsSlice";

vi.mock("../preferencesStore", () => ({
  usePreferencesStore: { getState: () => ({ set: vi.fn() }) },
}));

describe("isMouseBinding", () => {
  it("should be true for mouse tokens", () => {
    expect(isMouseBinding("Mouse3")).toBe(true);
    expect(isMouseBinding("Mouse4")).toBe(true);
    expect(isMouseBinding("Mouse5")).toBe(true);
  });

  it("should be false for keyboard codes", () => {
    expect(isMouseBinding("KeyV")).toBe(false);
    expect(isMouseBinding("CapsLock")).toBe(false);
    expect(isMouseBinding("Space")).toBe(false);
  });
});

describe("DOM_BUTTON_TO_MOUSE_TOKEN", () => {
  it("should map middle/back/forward and exclude left/right", () => {
    expect(DOM_BUTTON_TO_MOUSE_TOKEN[1]).toBe("Mouse3"); // middle
    expect(DOM_BUTTON_TO_MOUSE_TOKEN[3]).toBe("Mouse4"); // back
    expect(DOM_BUTTON_TO_MOUSE_TOKEN[4]).toBe("Mouse5"); // forward
    expect(DOM_BUTTON_TO_MOUSE_TOKEN[0]).toBeUndefined(); // left
    expect(DOM_BUTTON_TO_MOUSE_TOKEN[2]).toBeUndefined(); // right
  });
});

// `noiseReduction` was a boolean until noise reduction grew a third mode. It is still sitting in
// every existing user's localStorage and in `voice_settings` on the server, so it keeps arriving
// long after the upgrade. Losing it silently turns a deliberate "off" back on.
describe("migrateSettings", () => {
  it("should read a legacy true as standard", () => {
    const s = migrateSettings({ noiseReduction: true });

    expect(s.noiseReductionMode).toBe("standard");
  });

  // The one that actually costs a user something: they turned it off on purpose.
  it("should read a legacy false as off", () => {
    const s = migrateSettings({ noiseReduction: false });

    expect(s.noiseReductionMode).toBe("off");
  });

  it("should default to standard when nothing was stored", () => {
    expect(migrateSettings({}).noiseReductionMode).toBe("standard");
  });

  // An older client on another device keeps writing the boolean. It must not undo a mode chosen
  // here — otherwise the two devices fight and "strong" silently reverts to "standard".
  it("should let a stored mode win over a stale legacy boolean", () => {
    const s = migrateSettings({ noiseReductionMode: "strong", noiseReduction: true });

    expect(s.noiseReductionMode).toBe("strong");
  });

  it("should keep a stored off even when the legacy boolean says true", () => {
    const s = migrateSettings({ noiseReductionMode: "off", noiseReduction: true });

    expect(s.noiseReductionMode).toBe("off");
  });

  it("should not leave the legacy key on the migrated settings", () => {
    const s = migrateSettings({ noiseReduction: true });

    expect("noiseReduction" in s).toBe(false);
  });

  it("should keep every other setting it was given", () => {
    const s = migrateSettings({ noiseReduction: false, micSensitivity: 12, inputVolume: 150 });

    expect(s.micSensitivity).toBe(12);
    expect(s.inputVolume).toBe(150);
    expect(s.masterVolume).toBe(DEFAULT_SETTINGS.masterVolume);
  });
});

// Device ids are hashed per machine. Synced, the PC's headset id landed on the Mac as a saved
// speaker that is never plugged in: a "not connected" warning with Default shown as selected.
describe("machine-local device choices", () => {
  const local = { ...DEFAULT_SETTINGS, inputDevice: "mac-mic", outputDevice: "mac-headset" };

  it("should not send device ids to the server", () => {
    const sent = settingsForServer(local);

    expect("inputDevice" in sent).toBe(false);
    expect("outputDevice" in sent).toBe(false);
  });

  it("should still send the rest of the voice settings", () => {
    const sent = settingsForServer({ ...local, micSensitivity: 12, inputMode: "push_to_talk" });

    expect(sent.micSensitivity).toBe(12);
    expect(sent.inputMode).toBe("push_to_talk");
  });

  // Older clients keep uploading their own machine's ids.
  it("should keep this machine's devices over the server's", () => {
    const merged = mergeServerSettings(local, { inputDevice: "pc-mic", outputDevice: "pc-headset" });

    expect(merged.inputDevice).toBe("mac-mic");
    expect(merged.outputDevice).toBe("mac-headset");
  });

  it("should apply the server's other settings", () => {
    const merged = mergeServerSettings(local, { outputDevice: "pc-headset", masterVolume: 40 });

    expect(merged.masterVolume).toBe(40);
  });

  it("should still read the legacy noise reduction boolean from the server", () => {
    expect(mergeServerSettings(local, { noiseReduction: false }).noiseReductionMode).toBe("off");
  });

  it("should ignore keys the settings do not have", () => {
    const merged = mergeServerSettings(local, { somethingElse: 1 });

    expect("somethingElse" in merged).toBe(false);
  });
});
