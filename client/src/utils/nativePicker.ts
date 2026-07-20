/**
 * Native attachment picking on mobile.
 *
 * Web and Electron keep their `<input type="file">`; only Capacitor routes through the platform
 * pickers. The reason is not UX polish: a web `File` lives in the WebView's memory and native code
 * cannot open it, so a video the browser fails to decode could never be handed to a native frame
 * extractor. Picking natively yields a path that native code CAN open, with no byte copying.
 */

import { Capacitor } from "@capacitor/core";
import { FilePicker } from "@capawesome/capacitor-file-picker";
import { isCapacitor } from "./constants";

/**
 * What the composer asked for. Mirrors the three inputs it renders on web.
 *
 * "camera" deliberately keeps the web input: `capture="environment"` already hands the OS camera
 * app, and the capture is `image/*`, which the WebView decodes on its own. Native picking exists to
 * feed a native VIDEO decoder, so routing photos through it would buy nothing.
 */
export type PickKind = "media" | "files" | "camera";

/**
 * A picked attachment plus the native path behind it, when there is one.
 *
 * `nativePath` is what makes native poster extraction possible later; it is absent on web and for
 * anything the platform did not give us a path for.
 */
export type PickedAttachment = {
  file: File;
  nativePath?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
};

export function supportsNativePicker(kind: PickKind = "media"): boolean {
  return isCapacitor() && kind !== "camera";
}

/**
 * Native path for a picked File, remembered on the side.
 *
 * A `File` cannot carry extra fields, and threading the path through every place that holds
 * `File[]` — composer state, previews, upload, encryption — would touch a dozen call sites to serve
 * one of them. A WeakMap keeps the association without changing any of those shapes, and entries
 * disappear with the File itself.
 */
const nativePaths = new WeakMap<File, string>();

export function nativePathOf(file: File): string | undefined {
  return nativePaths.get(file);
}

/**
 * Turns a native path into a File the existing upload path can take.
 *
 * MEMORY NOTE — must be verified on a device before this is trusted for large videos: a web `File`
 * streams from disk during upload, whereas this materialises a Blob. Chromium backs large blobs
 * with disk rather than RAM, which would keep the behaviour equivalent, but that is an assumption
 * until measured. If it does hold the file in memory, the upload has to move to the native side
 * instead — see PHASE-117.
 */
async function fileFromNativePath(path: string, name: string, mimeType: string): Promise<File> {
  const response = await fetch(Capacitor.convertFileSrc(path));
  if (!response.ok) {
    throw new Error(`Failed to read picked file: HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const file = new File([blob], name, { type: mimeType || blob.type });
  nativePaths.set(file, path);
  return file;
}

/**
 * Backing out of the picker is a normal thing to do, and both plugins report it by throwing. The
 * only signal they give is the message text, which differs per plugin and per platform, so this is
 * matched loosely on purpose. Keeping it here means callers never have to know plugin error strings.
 */
function isCancellation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /cancel/i.test(message);
}

/**
 * Opens the platform picker. Returns an empty array when the user cancels — cancellation is not an
 * error and must not surface as one.
 */
export async function pickNative(kind: PickKind): Promise<PickedAttachment[]> {
  try {
    return await runPicker(kind);
  } catch (err) {
    if (isCancellation(err)) return [];
    throw err;
  }
}

async function runPicker(kind: PickKind): Promise<PickedAttachment[]> {
  const result =
    kind === "media"
      ? await FilePicker.pickMedia({ readData: false })
      : await FilePicker.pickFiles({ readData: false });

  const picked: PickedAttachment[] = [];
  for (const entry of result.files) {
    // readData is off on purpose — base64ing a 100 MB video to move it across the bridge would
    // cost far more than it buys.
    if (!entry.path) continue;
    picked.push({
      file: await fileFromNativePath(entry.path, entry.name, entry.mimeType),
      nativePath: entry.path,
      width: entry.width,
      height: entry.height,
      durationSeconds: entry.duration,
    });
  }
  return picked;
}
