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
 * Both mobile platforms. iOS was held back while its project carried neither the picker plugin nor
 * a native poster extractor — choosing the native path there would have thrown and taken the web
 * `<input>` fallback out of reach, breaking attaching outright rather than merely leaving it
 * unaccelerated. PHASE-05 shipped both, so the gate opens.
 *
 * "camera" stays on the web input everywhere: `capture="environment"` already hands over the OS
 * camera app and produces an image the WebView decodes on its own, so there is nothing to gain.
 */
export function supportsNativePicker(kind: PickKind = "media"): boolean {
  if (!isCapacitor() || kind === "camera") return false;
  const platform = Capacitor.getPlatform();
  return platform === "android" || platform === "ios";
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
  // Status 0 is not a failure. Only Android's converted URL points at a real local HTTP server;
  // iOS serves the file through a WKWebView custom scheme handler, and those responses carry no
  // status even when the entire body arrives. Treating 0 as not-ok refused every iOS pick while
  // holding the complete file, and the user saw only "could not read this file".
  if (response.status !== 0 && !response.ok) {
    throw new Error(`Failed to read picked file: HTTP ${response.status}`);
  }
  const blob = await response.blob();
  // With no status to trust on iOS, the body is the only evidence the read worked.
  if (blob.size === 0) {
    throw new Error("Picked file read back empty");
  }
  // blob.type is empty over the custom scheme, so the picker's own mime type leads.
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
      // error, not warn: the production build strips warn (vite.config.ts marks it pure), and this
      // is the only account of a failure the user is being shown a toast about.
      console.error(`[nativePicker] skipped ${entry.name}:`, err);
      skipped.push(entry.name);
    }
  }
  return { files: picked, skipped, oversized };
}
