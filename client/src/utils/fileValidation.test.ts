import { describe, it, expect } from "vitest";
import { validateFiles, partitionFiles } from "./fileValidation";
import { MAX_FILE_SIZE } from "./constants";

function fileOf(name: string, size: number, type = "image/png"): File {
  const f = new File([""], name, { type });
  // File size is read-only; the constructor cannot fake a large body cheaply.
  Object.defineProperty(f, "size", { value: size });
  return f;
}

describe("validateFiles", () => {
  it("should return every file as accepted when all are under the limit", () => {
    const files = [fileOf("a.png", 10), fileOf("b.png", 20)];

    const { accepted, rejected } = validateFiles(files, 100);

    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(0);
  });

  it("should report oversized files instead of dropping them silently", () => {
    const files = [fileOf("small.png", 10), fileOf("huge.mp4", 500)];

    const { accepted, rejected } = validateFiles(files, 100);

    expect(accepted.map((f) => f.name)).toEqual(["small.png"]);
    expect(rejected.map((f) => f.name)).toEqual(["huge.mp4"]);
  });

  it("should accept a file exactly on the limit", () => {
    const { accepted, rejected } = validateFiles([fileOf("edge.png", 100)], 100);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("should default to MAX_FILE_SIZE when no limit is given", () => {
    const { rejected } = validateFiles([fileOf("over.bin", MAX_FILE_SIZE + 1)]);

    expect(rejected).toHaveLength(1);
  });

  it("should accept a FileList-like input", () => {
    const files = [fileOf("a.png", 10)];

    const { accepted } = validateFiles(files, 100);

    expect(accepted).toHaveLength(1);
  });
});

describe("partitionFiles", () => {
  it("should split by the predicate without losing any file", () => {
    const files = [
      fileOf("keep.png", 1, "image/png"),
      fileOf("drop.pdf", 1, "application/pdf"),
      fileOf("keep2.png", 1, "image/png"),
    ];

    const { accepted, rejected } = partitionFiles(files, (f) => f.type === "image/png");

    expect(accepted.map((f) => f.name)).toEqual(["keep.png", "keep2.png"]);
    expect(rejected.map((f) => f.name)).toEqual(["drop.pdf"]);
    expect(accepted.length + rejected.length).toBe(files.length);
  });

  it("should evaluate the predicate exactly once per file", () => {
    const files = [fileOf("a.png", 1), fileOf("b.png", 1)];
    let calls = 0;

    partitionFiles(files, () => {
      calls += 1;
      return true;
    });

    expect(calls).toBe(files.length);
  });
});
