import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { ensureFreshToken } = vi.hoisted(() => ({ ensureFreshToken: vi.fn() }));

vi.mock("../api/client", () => ({ ensureFreshToken }));
vi.mock("../utils/nativePlugins", () => ({ APP_RESUME_EVENT: "mqvi:app-resume" }));
vi.mock("../stores/p2pCallStore", () => ({
  useP2PCallStore: { getState: () => ({ registerSendWS: vi.fn() }) },
}));
vi.mock("../stores/voiceStore", () => ({
  useVoiceStore: { getState: () => ({ isMuted: false, isDeafened: false }) },
}));
vi.mock("../utils/constants", () => ({
  WS_URL: "ws://test/ws",
  WS_HEARTBEAT_INTERVAL: 30_000,
  WS_HEARTBEAT_PROBE_INTERVAL: 10_000,
  WS_HEARTBEAT_MAX_MISS: 3,
  WS_MAX_RECONNECT_ATTEMPTS: 7,
}));
vi.mock("./ws/channelEventHandlers", () => ({ handleChannelEvent: async () => false }));
vi.mock("./ws/dmEventHandlers", () => ({ handleDMEvent: async () => false }));
vi.mock("./ws/voiceEventHandlers", () => ({ handleVoiceEvent: async () => false }));
vi.mock("./ws/systemEventHandlers", () => ({
  handleSystemEvent: async (
    msg: { op: string },
    _ctx: unknown,
    setStatus: (s: string) => void
  ) => {
    if (msg.op === "ready") {
      setStatus("connected");
      return true;
    }
    return false;
  },
}));

import { useWebSocket } from "./useWebSocket";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * Fake WebSocket. close() dispatches onclose on a microtask, matching the browser —
 * the stale-socket guard exists precisely because that event lands after the hook has
 * already installed a replacement socket.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  readyState = CONNECTING;
  sent: string[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.readyState = CLOSING;
    queueMicrotask(() => {
      this.readyState = CLOSED;
      this.onclose?.({ code: 1006, reason: "" });
    });
  }

  /** Test helper — completes the handshake. */
  accept() {
    this.readyState = OPEN;
    this.onopen?.();
  }

  /** Test helper — the peer drops the connection. */
  drop(code = 1006) {
    this.readyState = CLOSED;
    this.onclose?.({ code, reason: "" });
  }

  /** Test helper — pushes a server frame. */
  deliver(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  get heartbeats() {
    return this.sent.filter((s) => JSON.parse(s).op === "heartbeat").length;
  }
}

const originalWebSocket = globalThis.WebSocket;

function sockets() {
  return FakeSocket.instances;
}

function latest() {
  return FakeSocket.instances[FakeSocket.instances.length - 1];
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function resumeApp() {
  act(() => {
    window.dispatchEvent(new CustomEvent("mqvi:app-resume"));
  });
}

/** Mounts the hook and completes the initial handshake up to `ready`. */
async function connect() {
  const view = renderHook(() => useWebSocket());
  await advance(0);
  await act(async () => {
    latest().accept();
    latest().deliver({ op: "ready", d: {} });
  });
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  FakeSocket.instances = [];
  ensureFreshToken.mockReset().mockResolvedValue("token");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the global
  globalThis.WebSocket = FakeSocket as any;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  globalThis.WebSocket = originalWebSocket;
});

describe("useWebSocket connection status", () => {
  it("should report connecting when the socket drops and a retry is pending", async () => {
    const { result } = await connect();
    expect(result.current.connectionStatus).toBe("connected");

    await act(async () => {
      latest().drop();
    });

    expect(result.current.connectionStatus).toBe("connecting");
  });

  it("should report disconnected only once the attempt budget is exhausted", async () => {
    ensureFreshToken.mockResolvedValue(null);
    const { result } = renderHook(() => useWebSocket());

    await advance(0);
    expect(result.current.connectionStatus).toBe("connecting");

    // 7 attempts, capped at 20s each with +-25% jitter.
    await advance(150_000);

    expect(result.current.connectionStatus).toBe("disconnected");
    expect(sockets()).toHaveLength(0);
  });

  it("should keep retrying after the failure banner appears, without flipping back to connecting", async () => {
    ensureFreshToken.mockResolvedValue(null);
    const { result } = renderHook(() => useWebSocket());
    await advance(150_000);
    expect(result.current.connectionStatus).toBe("disconnected");

    // Network is back: the next capped retry must reconnect on its own.
    ensureFreshToken.mockResolvedValue("token");
    await advance(26_000);

    expect(sockets().length).toBeGreaterThan(0);
    // A silent retry must not repaint the banner yellow.
    expect(result.current.connectionStatus).toBe("disconnected");

    await act(async () => {
      latest().accept();
      latest().deliver({ op: "ready", d: {} });
    });
    expect(result.current.connectionStatus).toBe("connected");
  });

  it("should clear the exhausted latch so a later blip reports connecting again", async () => {
    ensureFreshToken.mockResolvedValue(null);
    const { result } = renderHook(() => useWebSocket());
    await advance(150_000);

    ensureFreshToken.mockResolvedValue("token");
    await advance(26_000);
    await act(async () => {
      latest().accept();
      latest().deliver({ op: "ready", d: {} });
    });

    await act(async () => {
      latest().drop();
    });
    expect(result.current.connectionStatus).toBe("connecting");
  });
});

describe("useWebSocket stale socket handling", () => {
  it("should ignore onclose from a socket that has already been replaced", async () => {
    const { result } = await connect();
    const stale = latest();

    // Mobile resume path: the socket is already gone, so the hook builds a new one.
    stale.readyState = CLOSED;
    resumeApp();
    await advance(0);

    expect(sockets()).toHaveLength(2);
    const live = latest();

    // The dead socket's queued close event lands late. It must not tear down the
    // replacement or schedule a competing reconnect.
    await act(async () => {
      stale.onclose?.({ code: 1006, reason: "" });
    });
    await advance(30_000);

    expect(sockets()).toHaveLength(2);
    expect(latest()).toBe(live);
    expect(result.current.connectionStatus).toBe("connecting");
  });
});

describe("useWebSocket resume probe", () => {
  it("should close a socket that reads OPEN but never acks the probe", async () => {
    await connect();
    const socket = latest();

    resumeApp();

    await advance(25_000);
    expect(socket.heartbeats).toBe(2);
    expect(socket.readyState).toBe(OPEN);

    await advance(5_000);
    expect(socket.heartbeats).toBe(3);
    expect(socket.readyState).not.toBe(OPEN);
  });

  it("should restore the steady-state interval once the probe is acked", async () => {
    await connect();
    const socket = latest();

    resumeApp();

    await advance(10_000);
    expect(socket.heartbeats).toBe(1);

    await act(async () => {
      socket.deliver({ op: "heartbeat_ack" });
    });

    // Probe cancelled: the next beat is a full interval away, not 10s.
    await advance(10_000);
    expect(socket.heartbeats).toBe(1);

    await advance(20_000);
    expect(socket.heartbeats).toBe(2);
    expect(socket.readyState).toBe(OPEN);
  });

  it("should not let an ack with no outstanding beat cancel the probe", async () => {
    await connect();
    const socket = latest();

    resumeApp();

    // An ack the OS buffered before the app froze: it answers no beat we just sent,
    // so it proves nothing about the socket and must leave the probe running.
    await act(async () => {
      socket.deliver({ op: "heartbeat_ack" });
    });

    await advance(30_000);
    expect(socket.heartbeats).toBe(3);
    expect(socket.readyState).not.toBe(OPEN);
  });
});
