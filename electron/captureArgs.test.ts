import { describe, it, expect } from "vitest";
import {
  captureHelperName,
  engineArgs,
  hasCaptureHelper,
  macAudioArgs,
  macCaptureTarget,
  macMajor,
  screenPermissionMissing,
  shareAudioSupported,
  smoothCaptureOffered,
} from "./captureArgs";

// These flags go from the renderer straight onto the helper's command line. A value the helper does
// not understand ends the share with a usage error, so it is refused here, where the reason is known.

describe("engineArgs", () => {
  it("should add nothing for smooth, so today's shares run exactly as before", () => {
    expect(engineArgs(undefined, undefined)).toEqual([]);
    expect(engineArgs("smooth", 3_000_000)).toEqual([]);
  });

  it("should pass sharp with its bitrate", () => {
    expect(engineArgs("sharp", 3_000_000)).toEqual(["--engine", "sharp", "--max-bitrate", "3000000"]);
  });

  it("should pass sharp without a bitrate when none was given", () => {
    expect(engineArgs("sharp", undefined)).toEqual(["--engine", "sharp"]);
  });

  it.each(["vp9", "", "SHARP", 1, null])("should refuse an engine it does not know: %s", (engine) => {
    expect(engineArgs(engine, undefined)).toBeNull();
  });

  it.each([0, -1, 1.5, 50_000, 50_000_000, "3000000", Number.NaN])(
    "should refuse a bitrate that is not a sane integer: %s",
    (bitrate) => {
      expect(engineArgs("sharp", bitrate)).toBeNull();
    }
  );
});

describe("the helper per platform", () => {
  it("should exist on Windows and macOS only", () => {
    expect(hasCaptureHelper("win32")).toBe(true);
    expect(hasCaptureHelper("darwin")).toBe(true);
    expect(hasCaptureHelper("linux")).toBe(false);
  });

  it("should be an .exe on Windows and a plain executable on macOS", () => {
    expect(captureHelperName("win32")).toBe("mqvi-game-capture.exe");
    expect(captureHelperName("darwin")).toBe("mqvi-game-capture");
  });
});

describe("macCaptureTarget", () => {
  it("should address a screen by its CGDirectDisplayID", () => {
    expect(macCaptureTarget("screen:69733632:0")).toEqual(["--display-id", "69733632"]);
  });

  it("should address a window by its CGWindowID", () => {
    expect(macCaptureTarget("window:12345:0")).toEqual(["--window-id", "12345"]);
  });

  // Throwing is what sends the share back to the browser instead of capturing something other than
  // what was picked.
  it.each(["screen:abc:0", "window:12345", "tab:1:0", "", undefined])(
    "should refuse a source it cannot address exactly: %s",
    (sourceId) => {
      expect(() => macCaptureTarget(sourceId)).toThrow();
    }
  );
});

describe("macAudioArgs", () => {
  it("should scope a window share's audio to that window", () => {
    expect(macAudioArgs("window:12345:0", 900)).toEqual(["--audio-capture", "--window-id", "12345", "--self-pid", "900"]);
  });

  it("should send everything but mqvi for a screen share", () => {
    expect(macAudioArgs("screen:1:0", 900)).toEqual(["--audio-capture", "--display-id", "1", "--self-pid", "900"]);
  });

  // The browser path can start audio without a picked source; it still must not echo the call.
  it.each([null, undefined, "", "tab:1:0"])("should fall back to everything but mqvi without a usable source: %s", (sourceId) => {
    expect(macAudioArgs(sourceId, 900)).toEqual(["--audio-capture", "--self-pid", "900"]);
  });
});

describe("what each platform can share", () => {
  it("should read the major macOS version", () => {
    expect(macMajor("14.5.0")).toBe(14);
    expect(macMajor("26.6.2")).toBe(26);
    expect(macMajor("")).toBe(0);
    expect(macMajor("garbage")).toBe(0);
  });

  it("should offer Smooth Video on Windows and on macOS 14 or later only", () => {
    expect(smoothCaptureOffered("win32", "10.0.26100")).toBe(true);
    expect(smoothCaptureOffered("darwin", "14.0.0")).toBe(true);
    expect(smoothCaptureOffered("darwin", "13.6.1")).toBe(false);
    expect(smoothCaptureOffered("linux", "6.8.0")).toBe(false);
  });

  it("should offer share audio on Windows and on macOS 13 or later only", () => {
    expect(shareAudioSupported("win32", "10.0.26100")).toBe(true);
    expect(shareAudioSupported("darwin", "13.0.0")).toBe(true);
    expect(shareAudioSupported("darwin", "12.7.6")).toBe(false);
    expect(shareAudioSupported("linux", "6.8.0")).toBe(false);
  });
});

describe("screenPermissionMissing", () => {
  it("should blame Screen Recording on macOS whenever the grant is not in place", () => {
    for (const status of ["denied", "not-determined", "restricted", "unknown"]) {
      expect(screenPermissionMissing("darwin", () => status)).toBe(true);
    }
  });

  it("should not blame it when granted, or anywhere but macOS", () => {
    expect(screenPermissionMissing("darwin", () => "granted")).toBe(false);
    expect(screenPermissionMissing("win32", () => "denied")).toBe(false);
    expect(screenPermissionMissing("linux", () => "denied")).toBe(false);
  });

  it("should not read the status when not on macOS", () => {
    // Electron's getMediaAccessStatus is missing on Linux; reading it there would throw.
    const missing = () => {
      throw new TypeError("systemPreferences.getMediaAccessStatus is not a function");
    };
    expect(screenPermissionMissing("linux", missing)).toBe(false);
    expect(screenPermissionMissing("win32", missing)).toBe(false);
  });
});
