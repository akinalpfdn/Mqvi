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

/**
 * Long edge of a generated chat thumbnail, in pixels.
 *
 * The message list caps an image at 300px tall but its width follows the bubble, so a landscape
 * photo can render near 600px wide — and at 2x DPR that is 1200 real pixels. 800 keeps a preview
 * that still looks sharp at those sizes while staying a small fraction of the original.
 */
const THUMBNAIL_MAX_EDGE = 800;

export type GeneratedThumbnail = {
  blob: Blob;
  width: number;
  height: number;
};

/**
 * Builds a small preview of an image file.
 *
 * Returns null whenever a thumbnail would be pointless or impossible — a source smaller than the
 * target, a format the browser cannot decode, an encoder failure. Callers must treat null as
 * normal and send the attachment without one; the preview is an optimisation, the file is the
 * message.
 */
export async function createThumbnail(file: File): Promise<GeneratedThumbnail | null> {
  if (!file.type.startsWith("image/")) return null;

  try {
    // from-image so a phone photo is decoded upright; the canvas itself carries no EXIF, so
    // skipping this would bake the rotation in the wrong orientation.
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const { width, height } = fitWithin(
      bitmap.width,
      bitmap.height,
      THUMBNAIL_MAX_EDGE,
      THUMBNAIL_MAX_EDGE
    );

    // Already small enough that a second copy would cost more than it saves.
    if (width === bitmap.width && height === bitmap.height) {
      bitmap.close();
      return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    // Alpha is kept: a transparent PNG previewed on a black background looks broken.
    const blob = await encodeCanvas(canvas, { alpha: true, quality: 0.8 });
    return blob ? { blob, width, height } : null;
  } catch {
    return null;
  }
}

/** How far into a video to grab the poster frame. Many videos open on a black or near-black frame. */
const POSTER_SEEK_SECONDS = 0.5;

/** Give up rather than hang a send on a video the browser will not decode. */
const POSTER_TIMEOUT_MS = 10_000;

/**
 * Grabs a still frame from a video to use as its preview.
 *
 * Depends on the browser being able to DECODE the source: HEVC from an iPhone often cannot be
 * decoded in a WebView, and that returns null here. Callers fall back to the previous behaviour —
 * an inline player that pulls part of the video to paint its own frame.
 */
export async function createVideoPoster(file: File): Promise<GeneratedThumbnail | null> {
  if (!file.type.startsWith("video/")) return null;

  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";

  try {
    const frame = await new Promise<GeneratedThumbnail | null>((resolve) => {
      const timer = window.setTimeout(() => finish(null), POSTER_TIMEOUT_MS);

      function finish(result: GeneratedThumbnail | null) {
        window.clearTimeout(timer);
        video.onloadedmetadata = null;
        video.onseeked = null;
        video.onerror = null;
        resolve(result);
      }

      video.onerror = () => finish(null);

      video.onloadedmetadata = () => {
        if (!video.videoWidth || !video.videoHeight) return finish(null);
        // A video shorter than the seek target still has a first frame worth showing.
        video.currentTime = Math.min(POSTER_SEEK_SECONDS, Math.max(0, video.duration / 2));
      };

      video.onseeked = () => {
        try {
          const { width, height } = fitWithin(
            video.videoWidth,
            video.videoHeight,
            THUMBNAIL_MAX_EDGE,
            THUMBNAIL_MAX_EDGE
          );
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) return finish(null);
          ctx.drawImage(video, 0, 0, width, height);

          // A poster is opaque by definition, so alpha buys nothing here.
          void encodeCanvas(canvas, { alpha: false, quality: 0.8 }).then((blob) =>
            finish(blob ? { blob, width, height } : null)
          );
        } catch {
          finish(null);
        }
      };

      video.src = objectUrl;
    });

    return frame;
  } finally {
    video.src = "";
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * The preview for any attachment that can have one — a scaled image or a video's poster frame.
 * Everything else gets null, which every caller treats as normal.
 */
export async function createAttachmentPreview(file: File): Promise<GeneratedThumbnail | null> {
  if (file.type.startsWith("video/")) return createVideoPoster(file);
  return createThumbnail(file);
}
