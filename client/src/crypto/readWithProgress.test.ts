import { describe, it, expect, vi } from "vitest";
import { readWithProgress } from "./fileEncryption";

/**
 * A minimal stand-in for the parts of Response readWithProgress touches: a streamed body, a
 * Content-Length header, and an arrayBuffer() fallback. Lets us drive the exact chunk sequence and
 * declared length the buffering branches key on.
 */
function fakeResponse(chunks: Uint8Array[], contentLength: number | null): Response {
  let i = 0;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  return {
    headers: {
      get: (h: string) =>
        h.toLowerCase() === "content-length" && contentLength !== null ? String(contentLength) : null,
    },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
      }),
    },
    arrayBuffer: async () => {
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      return merged.buffer;
    },
  } as unknown as Response;
}

const bytes = (...v: number[]) => new Uint8Array(v);

describe("readWithProgress", () => {
  it("returns exactly the payload when Content-Length matches, across multiple chunks", async () => {
    const res = fakeResponse([bytes(1, 2, 3), bytes(4, 5)], 5);
    const out = new Uint8Array(await readWithProgress(res, () => {}));
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports cumulative progress with the declared total", async () => {
    const onProgress = vi.fn();
    await readWithProgress(fakeResponse([bytes(1, 2), bytes(3)], 3), onProgress);
    expect(onProgress.mock.calls).toEqual([
      [2, 3],
      [3, 3],
    ]);
  });

  it("returns only the bytes read on a truncated response — never zero-padded to Content-Length", async () => {
    // Server promised 8 bytes but the stream ended after 3.
    const res = fakeResponse([bytes(9, 9, 9)], 8);
    const out = new Uint8Array(await readWithProgress(res, () => {}));
    expect(Array.from(out)).toEqual([9, 9, 9]);
  });

  it("returns the full body when it overruns the declared length", async () => {
    // Content-Length says 2 but the body carries 4 — must not truncate or write out of bounds.
    const res = fakeResponse([bytes(1, 2), bytes(3, 4)], 2);
    const out = new Uint8Array(await readWithProgress(res, () => {}));
    expect(Array.from(out)).toEqual([1, 2, 3, 4]);
  });

  it("collects and merges when there is no Content-Length", async () => {
    const onProgress = vi.fn();
    const res = fakeResponse([bytes(7), bytes(8, 9)], null);
    const out = new Uint8Array(await readWithProgress(res, onProgress));
    expect(Array.from(out)).toEqual([7, 8, 9]);
    // total is null throughout — the caller renders an indeterminate bar.
    expect(onProgress.mock.calls).toEqual([
      [1, null],
      [3, null],
    ]);
  });
});
