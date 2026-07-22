import { describe, it, expect } from "vitest";
import { fitWithin, extensionForType, hasTransparentPixels } from "./imageEncoding";

/** Two pixels' worth of RGBA, so a test can say only what the alpha bytes are. */
function canvasWithAlpha(...alphas: number[]) {
  const data = new Uint8ClampedArray(alphas.length * 4);
  alphas.forEach((alpha, index) => {
    data[index * 4 + 3] = alpha;
  });
  const canvas = { width: alphas.length, height: 1 } as HTMLCanvasElement;
  const ctx = { getImageData: () => ({ data }) } as unknown as CanvasRenderingContext2D;
  return { ctx, canvas };
}

describe("hasTransparentPixels", () => {
  it("should report no transparency when every pixel is fully opaque", () => {
    // The case that matters for size: a camera photo encodes as JPEG rather than PNG.
    const { ctx, canvas } = canvasWithAlpha(255, 255, 255);
    expect(hasTransparentPixels(ctx, canvas)).toBe(false);
  });

  it("should report transparency when a single pixel is not fully opaque", () => {
    const { ctx, canvas } = canvasWithAlpha(255, 254, 255);
    expect(hasTransparentPixels(ctx, canvas)).toBe(true);
  });

  it("should assume transparency when the canvas cannot be read", () => {
    // A tainted canvas throws. Guessing opaque there would flatten a logo's transparency to black.
    const canvas = { width: 1, height: 1 } as HTMLCanvasElement;
    const ctx = {
      getImageData: () => {
        throw new Error("tainted");
      },
    } as unknown as CanvasRenderingContext2D;
    expect(hasTransparentPixels(ctx, canvas)).toBe(true);
  });
});

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
