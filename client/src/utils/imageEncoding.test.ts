import { describe, it, expect } from "vitest";
import { fitWithin, extensionForType } from "./imageEncoding";

describe("fitWithin", () => {
  it("should scale a wide image down to the box width", () => {
    expect(fitWithin(4000, 3000, 1920, 1080)).toEqual({ width: 1440, height: 1080 });
  });

  it("should scale a tall image down to the box height", () => {
    expect(fitWithin(1000, 4000, 512, 512)).toEqual({ width: 128, height: 512 });
  });

  it("should preserve the aspect ratio", () => {
    const { width, height } = fitWithin(3000, 2000, 512, 512);

    expect(width / height).toBeCloseTo(3000 / 2000, 2);
  });

  it("should leave an image smaller than the box alone", () => {
    expect(fitWithin(200, 150, 512, 512)).toEqual({ width: 200, height: 150 });
  });

  it("should not upscale an image that is smaller in both dimensions", () => {
    const { width, height } = fitWithin(64, 64, 1920, 1080);

    expect(width).toBe(64);
    expect(height).toBe(64);
  });

  it("should leave an image exactly on the box unchanged", () => {
    expect(fitWithin(512, 512, 512, 512)).toEqual({ width: 512, height: 512 });
  });

  it("should never round a dimension down to zero", () => {
    // A 10000:1 sliver scaled into a 512 box rounds the short side below 1.
    const { width, height } = fitWithin(10000, 1, 512, 512);

    expect(width).toBe(512);
    expect(height).toBeGreaterThanOrEqual(1);
  });

  it("should return degenerate input unchanged rather than dividing by zero", () => {
    expect(fitWithin(0, 0, 512, 512)).toEqual({ width: 0, height: 0 });
  });
});

describe("extensionForType", () => {
  it("should map encoder output types to their extension", () => {
    expect(extensionForType("image/webp")).toBe("webp");
    expect(extensionForType("image/jpeg")).toBe("jpg");
    expect(extensionForType("image/png")).toBe("png");
  });

  it("should fall back to png for an unknown type", () => {
    // toBlob falls back to PNG when it cannot honour the requested type, so png is the safe guess.
    expect(extensionForType("image/avif")).toBe("png");
    expect(extensionForType("")).toBe("png");
  });
});
