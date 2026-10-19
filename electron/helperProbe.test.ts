import { describe, it, expect } from "vitest";
import { hdrActiveFrom, parseProbeAnswer, smoothSupportFrom } from "./helperProbe";

// The helper's answer decides what the share picker offers and warns about. A misread answer either
// hides "Smooth Video" from a machine that can run it or warns about HDR that is not there, so
// everything that is not a clean answer must come out as "could not tell".

const LOG = "[2026-10-19T12:16:33Z INFO  mqvi_game_capture::mf_encoder] encoder cfg cbr: ok";

describe("parseProbeAnswer", () => {
  it("should read the answer from the last line after log output", () => {
    expect(parseProbeAnswer(`${LOG}\n${LOG}\n{"hdr":true}\n`)).toEqual({ hdr: true });
  });

  it("should read an answer printed with CRLF", () => {
    expect(parseProbeAnswer(`${LOG}\r\n{"h264":true,"h265":false}\r\n`)).toEqual({ h264: true, h265: false });
  });

  it("should return null when the helper printed nothing, as an older one does for an unknown flag", () => {
    expect(parseProbeAnswer("")).toBeNull();
  });

  it("should return null when the last line is not JSON", () => {
    expect(parseProbeAnswer(`{"hdr":true}\n${LOG}`)).toBeNull();
  });

  it.each(["null", "[true]", "true", '"hdr"'])("should return null for JSON that is not an object: %s", (line) => {
    expect(parseProbeAnswer(line)).toBeNull();
  });
});

describe("smoothSupportFrom", () => {
  it("should be true when either codec works", () => {
    expect(smoothSupportFrom({ h264: false, h265: true })).toBe(true);
  });

  it("should be false when neither works", () => {
    expect(smoothSupportFrom({ h264: false, h265: false })).toBe(false);
  });

  it("should not count a truthy non-boolean as support", () => {
    expect(smoothSupportFrom({ h264: "none" })).toBe(false);
  });

  it("should be null without an answer", () => {
    expect(smoothSupportFrom(null)).toBeNull();
  });
});

describe("hdrActiveFrom", () => {
  it.each([true, false])("should pass a boolean answer through: %s", (hdr) => {
    expect(hdrActiveFrom({ hdr })).toBe(hdr);
  });

  it("should be null when the helper could not ask the displays", () => {
    expect(hdrActiveFrom({ hdr: null })).toBeNull();
  });

  it("should be null when the answer is about something else", () => {
    expect(hdrActiveFrom({ h264: true })).toBeNull();
  });
});
