/** Native engine on iOS, where WKWebView gets no microphone under CallKit; the page elsewhere. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { platform, built } = vi.hoisted(() => ({
  platform: { current: "web" as "web" | "ios" | "android" },
  built: [] as string[],
}));

vi.mock("../utils/constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/constants")>()),
  getCapacitorPlatform: () => platform.current,
}));
vi.mock("./WebCallEngine", () => ({
  WebCallEngine: class {
    constructor() {
      built.push("web");
    }
    async start() {}
    close() {}
  },
}));
vi.mock("./NativeCallEngine", () => ({
  NativeCallEngine: class {
    constructor() {
      built.push("native");
    }
    async start() {}
    close() {}
  },
}));
vi.mock("../i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("../stores/toastStore", () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));
vi.mock("../utils/nativePlugins", () => ({
  startVoiceCallService: vi.fn(),
  stopVoiceCallService: vi.fn(),
}));
vi.mock("../native/p2pCall", () => ({ dismissIncomingCallUI: vi.fn() }));

import { useP2PCallStore } from "../stores/p2pCallStore";
import type { P2PCall, P2PCallType } from "../types";

function call(callType: P2PCallType): P2PCall {
  return {
    id: "c1",
    caller_id: "them",
    caller_username: "them",
    caller_display_name: null,
    caller_avatar: null,
    receiver_id: "me",
    receiver_username: "me",
    receiver_display_name: null,
    receiver_avatar: null,
    call_type: callType,
    status: "active",
    created_at: "",
  };
}

beforeEach(() => {
  built.length = 0;
  platform.current = "web";
  useP2PCallStore.setState({ activeCall: null, engine: null, _sendWS: vi.fn() });
});

async function engineFor(p: "web" | "ios" | "android", callType: P2PCallType) {
  platform.current = p;
  useP2PCallStore.setState({ activeCall: call(callType), engine: null });
  await useP2PCallStore.getState().startWebRTC(true);
  return built[built.length - 1];
}

describe("engine selection", () => {
  it("should run an iOS voice call natively", async () => {
    expect(await engineFor("ios", "voice")).toBe("native");
  });

  it("should run an iOS video call natively as well", async () => {
    expect(await engineFor("ios", "video")).toBe("native");
  });

  it("should keep Android in the page", async () => {
    expect(await engineFor("android", "voice")).toBe("web");
  });

  it("should keep the browser in the page", async () => {
    expect(await engineFor("web", "voice")).toBe("web");
  });
});
