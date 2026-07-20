/**
 * Canvas sizing and encoding for uploads.
 *
 * The crop modal used to hand back a PNG at the crop box's SOURCE resolution — a square crop of a
 * 4000px phone photo became a 3000×3000 lossless PNG, which is how a server icon reached 4 MB on
 * the wire for a slot that renders at a few hundred pixels.
 */

/**
 * Scales a box down to fit inside another, preserving aspect ratio.
 * Never upscales: an image already smaller than the target is returned unchanged.
 */
export function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width, height };

  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Whether canvas can actually ENCODE WebP here.
 *
 * Probed rather than inferred from the platform: a browser that cannot encode the requested type
 * silently falls back to PNG, so the only honest test is to encode one pixel and read the type back.
 */
let webpProbe: Promise<boolean> | null = null;
function supportsWebPEncode(): Promise<boolean> {
  if (!webpProbe) {
    webpProbe = new Promise((resolve) => {
      try {
        const probe = document.createElement("canvas");
        probe.width = 1;
        probe.height = 1;
        probe.toBlob((blob) => resolve(blob?.type === "image/webp"), "image/webp");
      } catch {
        resolve(false);
      }
    });
  }
  return webpProbe;
}

type EncodeOptions = {
  /** Keep transparency. A circular avatar crop has transparent corners; JPEG would blacken them. */
  alpha: boolean;
  quality?: number;
};

/**
 * Encodes a canvas, preferring WebP and falling back to a format that preserves what matters:
 * PNG when transparency has to survive, JPEG when it does not.
 */
export async function encodeCanvas(
  canvas: HTMLCanvasElement,
  { alpha, quality = 0.9 }: EncodeOptions
): Promise<Blob | null> {
  const type = (await supportsWebPEncode())
    ? "image/webp"
    : alpha
      ? "image/png"
      : "image/jpeg";

  return new Promise((resolve) => {
    // PNG ignores the quality argument; passing it is harmless and keeps one call shape.
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

const EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

/** Filename extension matching an encoded blob, so the upload is not mislabelled as .png. */
export function extensionForType(mimeType: string): string {
  return EXTENSIONS[mimeType] ?? "png";
}
