/**
 * The game row shares without a picker, and a game is the likeliest thing to be HDR. It routes a
 * sharp share the same way the picker does: to the helper's tone-mapping engine on an HDR display.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../i18n", () => ({ default: { t: (k: string) => k, language: "en" } }));

import { useGameDetection } from "./useGameDetection";
import { useVoiceStore, type NativeCaptureResult } from "../stores/voiceStore";
import type { DetectedGame } from "../types/electron";

const GAME = { name: "Kenshi", sourceId: "window:42:0", icon: null } as unknown as DetectedGame;

let detected: (game: DetectedGame | null) => void = () => {};
const setPrePickedSource = vi.fn(() => Promise.resolve());
const startNativeCapture = vi.fn<(id: string, engine: string) => Promise<NativeCaptureResult>>();
const reportNativeFallback = vi.fn();

function installElectron(hdr: boolean) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: "win32",
    startGameDetection: () => Promise.resolve(),
    stopGameDetection: () => Promise.resolve(),
    removeGameDetectionListeners: () => {},
    onGameDetected: (cb: typeof detected) => (detected = cb),
    setPrePickedSource,
    getHdrActive: () => Promise.resolve(hdr),
  };
}

async function share() {
  const onFallbackShare = vi.fn();
  const { result } = renderHook(() => useGameDetection(true));
  act(() => detected(GAME));
  await act(async () => {
    await result.current.shareGame(onFallbackShare);
  });
  return onFallbackShare;
}

beforeEach(() => {
  setPrePickedSource.mockClear();
  startNativeCapture.mockReset().mockResolvedValue({ ok: true });
  reportNativeFallback.mockReset();
  useVoiceStore.setState({
    smoothCaptureSupported: true,
    screenShareMode: "sharp",
    startNativeCapture,
    reportNativeFallback,
  });
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("useGameDetection sharing sharp", () => {
  it("should use the helper's HDR engine on an HDR display", async () => {
    installElectron(true);
    const browserShare = await share();

    expect(startNativeCapture).toHaveBeenCalledWith("window:42:0", "sharp_hdr");
    expect(browserShare).not.toHaveBeenCalled();
  });

  it("should use the browser on an SDR display", async () => {
    installElectron(false);
    const browserShare = await share();

    expect(startNativeCapture).not.toHaveBeenCalled();
    expect(setPrePickedSource).toHaveBeenCalledWith("window:42:0");
    expect(browserShare).toHaveBeenCalled();
  });

  it("should fall back to the browser and report it when the HDR engine cannot start", async () => {
    installElectron(true);
    const failure = { ok: false, engine: "sharp_hdr", reason: "helper_failed", serverId: "s", channelId: "c" } as const;
    startNativeCapture.mockResolvedValue(failure);
    const browserShare = await share();

    expect(reportNativeFallback).toHaveBeenCalledWith(failure);
    expect(browserShare).toHaveBeenCalled();
  });
});
