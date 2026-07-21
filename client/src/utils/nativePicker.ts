// Native attachment picking on mobile. Web and Electron keep their `<input type="file">`: only a
// natively picked file has a path native code can open for frame extraction.

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

/**
 * Android only, deliberately. iOS is Capacitor too, but its project has not been synced with the
 * picker plugin (PHASE-119), so choosing the native path there throws and takes the web `<input>`
 * fallback out of reach — attaching would be broken outright rather than merely unaccelerated.
 */
export function supportsNativePicker(kind: PickKind = "media"): boolean {
  return isCapacitor() && Capacitor.getPlatform() === "android" && kind !== "camera";
}

// Native path for a picked File. A WeakMap avoids threading it through every File[] holder.
const nativePaths = new WeakMap<File, string>();

export function nativePathOf(file: File): string | undefined {
  return nativePaths.get(file);
}

// Turns a native path into a File. MEMORY: this materialises a Blob where a web File streams from
// disk. Assumed equivalent (Chromium backs large blobs with disk) but unmeasured — see PHASE-117.
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

/** What the picker came back with: what it could read, what it could not, and what was too big. */
export type PickResult = {
  files: PickedAttachment[];
  skipped: string[];
  oversized: { name: string }[];
};

/**
 * Opens the platform picker. Cancelling is not an error and comes back as an empty result.
 *
 * `maxBytes` is checked against the size the picker reports, before the file is read. Reading first
 * pulled the whole thing into the WebView — an 800MB video was fully materialised only to be
 * rejected by a 25MB cap, which is an OOM on a phone rather than a toast.
 *
 * `maxFiles` is how much room the composer has left, handed to the OS picker so it stops the
 * selection itself rather than letting someone choose fifteen photos and lose the message at submit.
 */
export async function pickNative(kind: PickKind, maxBytes: number, maxFiles: number): Promise<PickResult> {
  if (maxFiles <= 0) return { files: [], skipped: [], oversized: [] };
  try {
    return await runPicker(kind, maxBytes, maxFiles);
  } catch (err) {
    if (isCancellation(err)) return { files: [], skipped: [], oversized: [] };
    throw err;
  }
}

async function runPicker(kind: PickKind, maxBytes: number, maxFiles: number): Promise<PickResult> {
  const result =
    kind === "media"
      ? await FilePicker.pickMedia({ readData: false, limit: maxFiles })
      : await FilePicker.pickFiles({ readData: false, limit: maxFiles });

  // readData is off on purpose — base64ing a 100 MB video to move it across the bridge would cost
  // far more than it buys, so each file is read from its path instead.
  const picked: PickedAttachment[] = [];
  const skipped: string[] = [];
  const oversized: { name: string }[] = [];

  for (const entry of result.files) {
    if (!entry.path) {
      skipped.push(entry.name);
      continue;
    }
    if (entry.size > maxBytes) {
      oversized.push({ name: entry.name });
      continue;
    }
    try {
      picked.push({
        file: await fileFromNativePath(entry.path, entry.name, entry.mimeType),
        nativePath: entry.path,
        width: entry.width,
        height: entry.height,
        durationSeconds: entry.duration,
      });
    } catch (err) {
      // One unreadable file used to reject the whole call, throwing away everything already read.
      console.warn(`[nativePicker] skipped ${entry.name}:`, err);
      skipped.push(entry.name);
    }
  }
  return { files: picked, skipped, oversized };
}
