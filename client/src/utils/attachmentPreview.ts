/**
 * The single place that decides how an outgoing attachment's preview gets made.
 *
 * Order is browser first, native second, nothing third. The browser path works everywhere and needs
 * no plugin; the native path exists only for what Chromium cannot decode — chiefly HEVC video from
 * iPhones, which posted a blank frame before. Callers (channel send, DM send, E2EE encrypt) ask for
 * a preview and do not care which produced it.
 */

import { registerPlugin } from "@capacitor/core";
import { createAttachmentPreview, type GeneratedThumbnail } from "./imageEncoding";
import { nativePathOf, supportsNativePicker } from "./nativePicker";

type MediaPosterPlugin = {
  extractPoster(options: { path: string; atSeconds?: number }): Promise<{
    /** Base64 JPEG, no data: prefix. Affordable for a poster; would not be for the video. */
    data: string;
    width: number;
    height: number;
  }>;
};

const MediaPoster = registerPlugin<MediaPosterPlugin>("MediaPoster");

/** Matches POSTER_SEEK_SECONDS in the browser path so both pick a comparable frame. */
const POSTER_SEEK_SECONDS = 0.5;

function blobFromBase64(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

async function nativePoster(file: File): Promise<GeneratedThumbnail | null> {
  // Only videos, and only ones picked natively — anything else has no path to hand the decoder.
  if (!supportsNativePicker() || !file.type.startsWith("video/")) return null;
  const path = nativePathOf(file);
  if (!path) return null;

  try {
    const frame = await MediaPoster.extractPoster({ path, atSeconds: POSTER_SEEK_SECONDS });
    return {
      blob: blobFromBase64(frame.data, "image/jpeg"),
      width: frame.width,
      height: frame.height,
    };
  } catch (err) {
    // Sending without a poster is a worse-looking message, not a failed one.
    console.warn("[attachmentPreview] Native poster extraction failed:", err);
    return null;
  }
}

export async function buildAttachmentPreview(file: File): Promise<GeneratedThumbnail | null> {
  const browserPreview = await createAttachmentPreview(file);
  if (browserPreview) return browserPreview;
  return nativePoster(file);
}
