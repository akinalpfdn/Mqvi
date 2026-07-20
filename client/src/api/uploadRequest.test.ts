import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { uploadRequest, UPLOAD_ABORTED } from "./client";

/**
 * The upload transport carries auth behaviour that used to live in one place (apiClient) and now
 * lives in two. These tests pin the parity: Bearer header, credentials, the single 401 refresh and
 * retry, the APIResponse envelope, and the promise that must never reject.
 */

type Handler = (xhr: MockXHR) => void;

class MockXHR {
  static instances: MockXHR[] = [];
  /** Called on send() so a test can decide how this particular request resolves. */
  static onSend: Handler = (xhr) => xhr.respond(200, '{"success":true,"data":{"ok":1}}');

  upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  status = 0;
  statusText = "";
  responseText = "";
  withCredentials = false;
  headers: Record<string, string> = {};
  method = "";
  url = "";
  sent = false;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }
  send() {
    this.sent = true;
    MockXHR.instances.push(this);
    MockXHR.onSend(this);
  }
  abort() {
    this.onabort?.();
  }

  respond(status: number, body: string, statusText = "OK") {
    this.status = status;
    this.statusText = statusText;
    this.responseText = body;
    this.onload?.();
  }
  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ loaded, total, lengthComputable } as ProgressEvent);
  }
}

function form(): FormData {
  const f = new FormData();
  f.append("content", "hi");
  return f;
}

beforeEach(() => {
  MockXHR.instances = [];
  MockXHR.onSend = (xhr) => xhr.respond(200, '{"success":true,"data":{"ok":1}}');
  vi.stubGlobal("XMLHttpRequest", MockXHR);
  localStorage.setItem("access_token", "tok-1");
  localStorage.setItem("refresh_token", "refresh-1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("uploadRequest", () => {
  it("should return the parsed envelope on success", async () => {
    const res = await uploadRequest<{ ok: number }>("/x", form());

    expect(res.success).toBe(true);
    expect(res.data).toEqual({ ok: 1 });
  });

  it("should send credentials and the bearer token, and never set Content-Type by hand", async () => {
    await uploadRequest("/x", form());
    const xhr = MockXHR.instances[0];

    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers["Authorization"]).toBe("Bearer tok-1");
    // The browser must derive it from the FormData so the multipart boundary is correct.
    expect(xhr.headers["Content-Type"]).toBeUndefined();
  });

  it("should surface a non-JSON body as an HTTP error instead of throwing", async () => {
    MockXHR.onSend = (xhr) => xhr.respond(413, "<html>Request Entity Too Large</html>", "Payload Too Large");

    const res = await uploadRequest("/x", form());

    expect(res.success).toBe(false);
    expect(res.error).toBe("HTTP 413: Payload Too Large");
  });

  it("should treat 204 as success with no data", async () => {
    MockXHR.onSend = (xhr) => xhr.respond(204, "");

    const res = await uploadRequest("/x", form());

    expect(res.success).toBe(true);
    expect(res.data).toBeUndefined();
  });

  it("should report a network error as a failed envelope, not a rejection", async () => {
    MockXHR.onSend = (xhr) => xhr.onerror?.();

    const res = await uploadRequest("/x", form());

    expect(res.success).toBe(false);
    expect(res.error).toBe("Network request failed");
  });

  it("should mark a cancelled upload with the abort code", async () => {
    MockXHR.onSend = (xhr) => xhr.abort();

    const res = await uploadRequest("/x", form());

    expect(res.success).toBe(false);
    expect(res.code).toBe(UPLOAD_ABORTED);
  });

  it("should not send at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const res = await uploadRequest("/x", form(), { signal: controller.signal });

    expect(res.code).toBe(UPLOAD_ABORTED);
    expect(MockXHR.instances).toHaveLength(0);
  });

  it("should abort the in-flight request when the signal fires", async () => {
    MockXHR.onSend = () => {
      /* leave it hanging so the signal decides the outcome */
    };
    const controller = new AbortController();

    const pending = uploadRequest("/x", form(), { signal: controller.signal });
    controller.abort();

    expect((await pending).code).toBe(UPLOAD_ABORTED);
  });

  it("should report progress and settle on the total so a bar cannot stick below 100%", async () => {
    const seen: Array<[number, number | null]> = [];
    MockXHR.onSend = (xhr) => {
      xhr.progress(40, 100);
      xhr.respond(200, '{"success":true}');
    };

    await uploadRequest("/x", form(), { onProgress: (l, t) => seen.push([l, t]) });

    expect(seen[0]).toEqual([40, 100]);
    expect(seen[seen.length - 1]).toEqual([100, 100]);
  });

  it("should report an indeterminate total when the browser cannot compute it", async () => {
    const seen: Array<[number, number | null]> = [];
    MockXHR.onSend = (xhr) => {
      xhr.progress(40, 0, false);
      xhr.respond(200, '{"success":true}');
    };

    await uploadRequest("/x", form(), { onProgress: (l, t) => seen.push([l, t]) });

    expect(seen[0]).toEqual([40, null]);
  });

  it("should refresh once and retry after a 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { access_token: "tok-2", refresh_token: "refresh-2", file_token: "file-2" },
        }),
      })
    );
    let call = 0;
    MockXHR.onSend = (xhr) => {
      call += 1;
      if (call === 1) xhr.respond(401, '{"success":false,"error":"expired"}', "Unauthorized");
      else xhr.respond(200, '{"success":true,"data":{"ok":2}}');
    };

    const res = await uploadRequest<{ ok: number }>("/x", form());

    expect(MockXHR.instances).toHaveLength(2);
    expect(MockXHR.instances[1].headers["Authorization"]).toBe("Bearer tok-2");
    expect(res.success).toBe(true);
  });

  it("should return the original 401 when the refresh fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    MockXHR.onSend = (xhr) => xhr.respond(401, '{"success":false,"error":"expired"}', "Unauthorized");

    const res = await uploadRequest("/x", form());

    expect(MockXHR.instances).toHaveLength(1);
    expect(res.success).toBe(false);
  });
});
