import { describe, it, expect } from "vitest";
import { engineArgs } from "./captureArgs";

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
