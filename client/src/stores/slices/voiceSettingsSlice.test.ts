import { describe, it, expect, vi } from "vitest";
import {
  isMouseBinding,
  DOM_BUTTON_TO_MOUSE_TOKEN,
  migrateSettings,
  DEFAULT_SETTINGS,
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
