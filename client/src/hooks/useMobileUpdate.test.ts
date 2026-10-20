/** The mobile update prompt: what each combination of server minimum and store version shows. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const env = vi.hoisted(() => ({
  capacitor: true,
  platform: "android",
  version: "1.1.0",
  minimum: { android: "", ios: "" },
  policyOk: true,
  store: null as null | Record<string, unknown>,
  resume: null as null | (() => void),
}));

vi.mock("../utils/constants", () => ({
  isCapacitor: () => env.capacitor,
  getCapacitorPlatform: () => env.platform,
}));
vi.mock("@capacitor/app", () => ({
  App: {
    getInfo: vi.fn(async () => ({ version: env.version })),
    addListener: vi.fn(async (_event: string, cb: () => void) => {
      env.resume = cb;
      return { remove: vi.fn() };
    }),
  },
}));
vi.mock("@capawesome/capacitor-app-update", () => ({
  AppUpdateAvailability: { UNKNOWN: 0, UPDATE_NOT_AVAILABLE: 1, UPDATE_AVAILABLE: 2, UPDATE_IN_PROGRESS: 3 },
  AppUpdate: {
    getAppUpdateInfo: vi.fn(async () => {
      if (!env.store) throw new Error("no store");
      return env.store;
    }),
    performImmediateUpdate: vi.fn(async () => ({ code: 0 })),
    openAppStore: vi.fn(async () => undefined),
  },
}));
vi.mock("../api/clientPolicy", () => ({
  getClientPolicy: vi.fn(async () =>
    env.policyOk ? { success: true, data: { min_versions: env.minimum } } : { success: false, error: "down" },
  ),
}));

import { AppUpdate } from "@capawesome/capacitor-app-update";
import { useP2PCallStore } from "../stores/p2pCallStore";
import { useVoiceStore } from "../stores/voiceStore";
import { useMobileUpdate } from "./useMobileUpdate";

const newer = { updateAvailability: 2, availableVersionCode: "9", immediateUpdateAllowed: true };

/** Lets a launch check run to the end, so "shows nothing" is a result, not a check still pending. */
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  Object.assign(env, {
    capacitor: true,
    platform: "android",
    version: "1.1.0",
    minimum: { android: "", ios: "" },
    policyOk: true,
    store: null,
    resume: null,
  });
  localStorage.clear();
  vi.clearAllMocks();
  useVoiceStore.setState({ currentVoiceChannelId: null });
  useP2PCallStore.setState({ activeCall: null, incomingCall: null });
});

describe("useMobileUpdate", () => {
  it("shows nothing when up to date", async () => {
    env.store = { updateAvailability: 1 };
    const { result } = renderHook(() => useMobileUpdate());
    await settle();
    expect(result.current.state).toEqual({ kind: "none" });
  });

  it("blocks below the server's minimum for this platform", async () => {
    env.minimum = { android: "1.2.0", ios: "" };
    const { result } = renderHook(() => useMobileUpdate());
    await waitFor(() => expect(result.current.state).toEqual({ kind: "required" }));
  });

  it("uses the iOS minimum on iOS", async () => {
    env.platform = "ios";
    env.minimum = { android: "9.0.0", ios: "" };
    const lenient = renderHook(() => useMobileUpdate());
    await settle();
    expect(lenient.result.current.state).toEqual({ kind: "none" });

    env.minimum = { android: "", ios: "1.2.0" };
    const strict = renderHook(() => useMobileUpdate());
    await waitFor(() => expect(strict.result.current.state).toEqual({ kind: "required" }));
  });

  it("does not block when the server cannot be reached", async () => {
    env.policyOk = false;
    env.minimum = { android: "9.0.0", ios: "" };
    const { result } = renderHook(() => useMobileUpdate());
    await settle();
    expect(result.current.state).toEqual({ kind: "none" });
  });

  it("offers a newer store version, and remembers when it is put off", async () => {
    env.store = newer;
    const first = renderHook(() => useMobileUpdate());
    await waitFor(() => expect(first.result.current.state).toEqual({ kind: "available", id: "9" }));

    act(() => first.result.current.dismiss());
    expect(first.result.current.state).toEqual({ kind: "none" });

    const next = renderHook(() => useMobileUpdate());
    await settle();
    expect(next.result.current.state).toEqual({ kind: "none" });
  });

  it("checks again when the app comes back to the foreground", async () => {
    const { result } = renderHook(() => useMobileUpdate());
    await waitFor(() => expect(env.resume).not.toBeNull());
    expect(result.current.state).toEqual({ kind: "none" });

    env.minimum = { android: "1.2.0", ios: "" }; // raised on the server meanwhile
    await act(async () => env.resume?.());
    await waitFor(() => expect(result.current.state).toEqual({ kind: "required" }));
  });

  it("updates through Play's own screen on Android when it allows", async () => {
    env.store = newer;
    const { result } = renderHook(() => useMobileUpdate());
    await waitFor(() => expect(result.current.state.kind).toBe("available"));

    await act(async () => result.current.update());
    expect(AppUpdate.performImmediateUpdate).toHaveBeenCalledTimes(1);
    expect(AppUpdate.openAppStore).not.toHaveBeenCalled();
  });

  it("opens the store page otherwise", async () => {
    env.platform = "ios";
    env.store = { updateAvailability: 2, availableVersionName: "1.2.0" };
    const { result } = renderHook(() => useMobileUpdate());
    await waitFor(() => expect(result.current.state).toEqual({ kind: "available", id: "1.2.0" }));

    await act(async () => result.current.update());
    expect(AppUpdate.openAppStore).toHaveBeenCalledWith({ appId: "6761312531" });
    expect(AppUpdate.performImmediateUpdate).not.toHaveBeenCalled();
  });

  it("holds a required update back during a call and shows it when the call ends", async () => {
    env.minimum = { android: "1.2.0", ios: "" };
    useP2PCallStore.setState({ activeCall: { id: "c1" } as never });
    const { result } = renderHook(() => useMobileUpdate());
    await settle();
    expect(result.current.state).toEqual({ kind: "none" });

    act(() => useP2PCallStore.setState({ activeCall: null }));
    expect(result.current.state).toEqual({ kind: "required" });
  });

  it("holds an offered update back in a voice channel", async () => {
    env.store = newer;
    useVoiceStore.setState({ currentVoiceChannelId: "v1" });
    const { result } = renderHook(() => useMobileUpdate());
    await settle();
    expect(result.current.state).toEqual({ kind: "none" });

    act(() => useVoiceStore.setState({ currentVoiceChannelId: null }));
    expect(result.current.state).toEqual({ kind: "available", id: "9" });
  });

  it("does nothing outside the mobile apps", async () => {
    env.capacitor = false;
    env.minimum = { android: "9.0.0", ios: "9.0.0" };
    const { result } = renderHook(() => useMobileUpdate());
    await act(async () => {});
    expect(AppUpdate.getAppUpdateInfo).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: "none" });
  });
});
