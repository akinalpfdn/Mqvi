// Canvas sizing and encoding for uploads.

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

/** Long edge of a chat thumbnail. 800 stays sharp at the ~600px-wide, 2x-DPR worst case. */
const THUMBNAIL_MAX_EDGE = 800;

export type GeneratedThumbnail = {
  blob: Blob;
  width: number;
  height: number;
};

/** Small preview of an image. Null (source already small, undecodable, encoder failed) is normal. */
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

/** Still frame from a video. Null when the browser cannot decode the source (typically iPhone HEVC). */
export async function createVideoPoster(
  file: File,
  signal?: AbortSignal
): Promise<GeneratedThumbnail | null> {
  if (!file.type.startsWith("video/")) return null;
  if (signal?.aborted) return null;

  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";

  try {
    const frame = await new Promise<GeneratedThumbnail | null>((resolve) => {
      const timer = window.setTimeout(() => finish(null), POSTER_TIMEOUT_MS);
      // Cancelling the send must not wait out a video the browser is slow to decode (up to the
      // timeout above). Bail the moment the upload is aborted.
      const onAbort = () => finish(null);
      signal?.addEventListener("abort", onAbort);

      function finish(result: GeneratedThumbnail | null) {
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        video.onloadedmetadata = null;
        video.onloadeddata = null;
        video.onseeked = null;
        video.onerror = null;
        resolve(result);
      }

      video.onerror = () => finish(null);

      function capture() {
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
      }

      // Whether we asked for a seek. If we did, the frame is taken on `seeked`; if we did not, on
      // `loadeddata`. Without this split a video with no usable duration never captured at all and
      // only the timeout ended it — ten seconds of a blocked send, per file.
      let seeking = false;

      video.onloadedmetadata = () => {
        if (!video.videoWidth || !video.videoHeight) return finish(null);
        // duration is NaN for some sources and 0 for others. currentTime is a restricted double, so
        // assigning NaN throws out of this handler and finish() would never run; assigning the
        // current time is a no-op that never fires `seeked`. Only seek when it can actually move.
        const { duration } = video;
        if (!Number.isFinite(duration) || duration <= 0) {
          // Capture falls to `loadeddata`, which needs HAVE_CURRENT_DATA — more than preload
          // "metadata" is obliged to fetch. Nudge the element to keep going. Not load(), which
          // restarts resource selection and would re-fire this handler forever.
          video.preload = "auto";
          return;
        }
        try {
          video.currentTime = Math.min(POSTER_SEEK_SECONDS, duration / 2);
          seeking = true;
        } catch {
          // Leave seeking false — the first frame is captured on loadeddata instead.
        }
      };

      video.onloadeddata = () => {
        if (!seeking) capture();
      };

      video.onseeked = () => capture();

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
export async function createAttachmentPreview(
  file: File,
  signal?: AbortSignal
): Promise<GeneratedThumbnail | null> {
  if (signal?.aborted) return null;
  if (file.type.startsWith("video/")) return createVideoPoster(file, signal);
  return createThumbnail(file);
}

