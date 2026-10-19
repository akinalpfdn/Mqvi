import { describe, it, expect } from "vitest";
import { NATIVE_CAPTURE_TRACK_NAME, NATIVE_SHARP_TRACK_NAME, shareEngine } from "./constants";

// Viewers are told which mode a share is in. Every native share — both helper engines and a phone's
// — arrives as the same "_ss" sub-participant, so only the track name can tell them apart.

describe("shareEngine", () => {
  it("should label the helper's hardware engine as smooth", () => {
    expect(shareEngine(NATIVE_CAPTURE_TRACK_NAME, "u1_ss")).toBe("smooth");
  });

  // The bug: the HDR engine published under the smooth name, so its viewers read "Smooth Video".
  it("should label the helper's HDR engine as sharp, not smooth", () => {
    expect(shareEngine(NATIVE_SHARP_TRACK_NAME, "u1_ss")).toBe("sharp");
  });

  it("should label any other sub-participant share as a phone's", () => {
    expect(shareEngine("screen", "u1_ss")).toBe("mobile");
  });

  it("should label a browser share as sharp", () => {
    expect(shareEngine("screen", "u1")).toBe("sharp");
  });
});
