import { describe, it, expect, vi, beforeEach } from "vitest";

const { pickMedia, convertFileSrc, getPlatform } = vi.hoisted(() => ({
  pickMedia: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `capacitor://localhost/_capacitor_file_${path}`),
  getPlatform: vi.fn(() => "ios"),
}));

vi.mock("@capacitor/core", () => ({ Capacitor: { convertFileSrc, getPlatform } }));
vi.mock("@capawesome/capacitor-file-picker", () => ({ FilePicker: { pickMedia } }));
vi.mock("./constants", () => ({ isCapacitor: () => true }));

import { pickNative } from "./nativePicker";

/** One picked video, the shape the plugin returns for a clip recorded on the device. */
function pickerReturns(size: number) {
  pickMedia.mockResolvedValue({
    files: [
      {
        path: "file:///var/mobile/Containers/Data/Application/APP/Library/Caches/TMP/clip.mov",
        name: "clip.mov",
        mimeType: "video/quicktime",
        size,
        width: 672,
        height: 1232,
        duration: 6,
      },
    ],
  });
}

function fetchReturns(status: number, byteLength: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      status,
      ok: status >= 200 && status < 300,
      blob: async () => new Blob([new Uint8Array(byteLength)]),
    }))
  );
}

describe("pickNative", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    pickMedia.mockReset();
  });

  it("should accept a file served with no status when the body arrives", async () => {
    // iOS reads the picked file through a WKWebView custom scheme, which reports status 0 even on a
    // complete response. Refusing that held the whole file and told the user it was unreadable.
    pickerReturns(5_686_784);
    fetchReturns(0, 5_686_784);

    const result = await pickNative("media", 25 * 1024 * 1024, 10);

    expect(result.skipped).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].file.type).toBe("video/quicktime");
    expect(result.files[0].file.size).toBe(5_686_784);
  });

  it("should skip a file whose body comes back empty", async () => {
    // With no status to trust, an empty read is the only signal left that the file is unreadable.
    pickerReturns(5_686_784);
    fetchReturns(0, 0);

    const result = await pickNative("media", 25 * 1024 * 1024, 10);

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual(["clip.mov"]);
  });

  it("should skip a file the local server reports as missing", async () => {
    // Android's converted URL is a real HTTP server, so there a status still means something.
    pickerReturns(5_686_784);
    fetchReturns(404, 120);

    const result = await pickNative("media", 25 * 1024 * 1024, 10);

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual(["clip.mov"]);
  });

  it("should refuse a file larger than the limit without reading it", async () => {
    pickerReturns(30 * 1024 * 1024);
    fetchReturns(0, 30 * 1024 * 1024);

    const result = await pickNative("media", 25 * 1024 * 1024, 10);

    expect(result.oversized).toEqual([{ name: "clip.mov" }]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
