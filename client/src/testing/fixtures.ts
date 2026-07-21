/**
 * Shapes tests keep rebuilding by hand: the API envelope, a WS event, a message with attachments.
 *
 * Hand-built literals drift from the real shape the moment a field is added, and a test that
 * asserts against its own invention proves nothing. Every factory here takes overrides, so a test
 * states only what it cares about.
 */

import type { APIResponse } from "../types";

/** A successful API envelope. */
export function okResponse<T>(data: T): APIResponse<T> {
  return { success: true, data };
}

/** A failed API envelope, optionally carrying the code the client maps to a message. */
export function errResponse<T>(error: string, code?: string): APIResponse<T> {
  return { success: false, error, ...(code ? { code } : {}) } as APIResponse<T>;
}

/** Minimal attachment, with thumbnail fields off unless a test asks for them. */
export function attachment(overrides: Partial<Attachmentish> = {}): Attachmentish {
  return {
    id: "a1",
    filename: "photo.jpg",
    file_url: "/api/files/messages/c1/photo.jpg",
    file_size: 1024,
    mime_type: "image/jpeg",
    ...overrides,
  };
}

/** Structural type, so the factory does not drag component prop types into every test. */
export type Attachmentish = {
  id: string;
  filename: string;
  file_url: string;
  file_size?: number | null;
  mime_type?: string | null;
  thumb_url?: string | null;
  thumb_width?: number | null;
  thumb_height?: number | null;
};

/** A WS event as the socket delivers it. */
export function wsEvent<T>(op: string, data: T, seq = 1) {
  return { op, d: data, seq };
}

/**
 * A Response stand-in for the streaming paths, with a body that yields the given chunks.
 *
 * `fetch` is what tests usually mock, and a bare `{ ok: true }` object misses the reader those
 * paths actually use.
 */
export function streamedResponse(chunks: Uint8Array[], contentLength: number | null): Response {
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === "content-length" && contentLength !== null ? String(contentLength) : null,
    },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
    arrayBuffer: async () => {
      const total = chunks.reduce((n, c) => n + c.length, 0);
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
