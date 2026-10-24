import { describe, it, expect, vi } from "vitest";
import { choosePublishEngine, hasCaptureHelper, resolvePublishEngine, sharpShareEncoding } from "./publishEngine";

// The routing decides whether an HDR streamer's viewers get a correct picture or a blown-out one,
// and whether a machine without a hardware encoder ever tries the helper. Every branch is a real
// user's setup.

const base = { smoothSupported: true, hdrActive: false, hasHelper: true } as const;

describe("choosePublishEngine", () => {
  it("should keep sharp in the browser on an SDR display", () => {
    expect(choosePublishEngine({ ...base, mode: "sharp" })).toBe("browser");
  });

  it("should move sharp to the helper on an HDR display", () => {
    expect(choosePublishEngine({ ...base, mode: "sharp", hdrActive: true })).toBe("sharp_hdr");
  });

  it("should keep smooth on the helper whatever the display", () => {
    expect(choosePublishEngine({ ...base, mode: "smooth" })).toBe("smooth");
    expect(choosePublishEngine({ ...base, mode: "smooth", hdrActive: true })).toBe("smooth");
  });

  it("should still try smooth when the encoder probe could not answer", () => {
    expect(choosePublishEngine({ ...base, mode: "smooth", smoothSupported: null })).toBe("smooth");
  });

  // No hardware encoder means the share is sharp — and sharp_hdr needs none, which is the one HDR
  // fix such a machine can have.
  it("should give a machine without a hardware encoder the HDR sharp engine on an HDR display", () => {
    expect(choosePublishEngine({ ...base, mode: "smooth", smoothSupported: false, hdrActive: true })).toBe("sharp_hdr");
  });

  it("should keep the browser when HDR could not be asked", () => {
    expect(choosePublishEngine({ ...base, mode: "sharp", hdrActive: null })).toBe("browser");
  });

  it("should never pick the helper where there is none", () => {
    expect(choosePublishEngine({ ...base, mode: "smooth", hasHelper: false })).toBe("browser");
    expect(choosePublishEngine({ ...base, mode: "sharp", hdrActive: true, hasHelper: false })).toBe("browser");
  });
});

describe("resolvePublishEngine", () => {
  const opts = { smoothSupported: true, hasHelper: true } as const;

  it("should not wait on the HDR probe for a smooth share", async () => {
    const askHdr = vi.fn(() => Promise.resolve(true));
    expect(await resolvePublishEngine({ ...opts, mode: "smooth", askHdr })).toBe("smooth");
    expect(askHdr).not.toHaveBeenCalled();
  });

  it("should ask about HDR for a sharp share and follow the answer", async () => {
    expect(await resolvePublishEngine({ ...opts, mode: "sharp", askHdr: () => Promise.resolve(true) })).toBe("sharp_hdr");
    expect(await resolvePublishEngine({ ...opts, mode: "sharp", askHdr: () => Promise.resolve(false) })).toBe("browser");
  });

  it("should keep the browser when the probe fails", async () => {
    const askHdr = () => Promise.reject(new Error("ipc"));
    expect(await resolvePublishEngine({ ...opts, mode: "sharp", askHdr })).toBe("browser");
  });

  it("should not ask where there is no helper", async () => {
    const askHdr = vi.fn(() => Promise.resolve(true));
    expect(await resolvePublishEngine({ ...opts, mode: "sharp", hasHelper: false, askHdr })).toBe("browser");
    expect(askHdr).not.toHaveBeenCalled();
  });
});

describe("sharpShareEncoding", () => {
  it("should match the browser engine's ceilings", () => {
    expect(sharpShareEncoding("1080p")).toEqual({ maxBitrate: 3_000_000, maxFramerate: 30 });
    expect(sharpShareEncoding("720p")).toEqual({ maxBitrate: 1_500_000, maxFramerate: 30 });
  });
});

describe("hasCaptureHelper", () => {
  it("should offer the helper in the Windows and macOS desktop apps only", () => {
    expect(hasCaptureHelper("win32")).toBe(true);
    expect(hasCaptureHelper("darwin")).toBe(true);
    expect(hasCaptureHelper("linux")).toBe(false);
    // The browser has no electronAPI at all.
    expect(hasCaptureHelper(undefined)).toBe(false);
  });
});
