/**
 * The game row shares without a picker, so the picker's HDR warning never shows for it — and a
 * game is exactly what HDR makes overexposed. The row says it after the share starts instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../i18n", () => ({ default: { t: (k: string) => k, language: "en" } }));

import { useGameDetection } from "./useGameDetection";
import { useVoiceStore } from "../stores/voiceStore";
import { useToastStore } from "../stores/toastStore";
import type { DetectedGame } from "../types/electron";

const GAME = { name: "Kenshi", sourceId: "window:42:0", icon: null } as unknown as DetectedGame;

let detected: (game: DetectedGame | null) => void = () => {};

function installElectron(hdr: boolean) {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: "win32",
    startGameDetection: () => Promise.resolve(),
    stopGameDetection: () => Promise.resolve(),
    removeGameDetectionListeners: () => {},
    onGameDetected: (cb: typeof detected) => (detected = cb),
    setPrePickedSource: () => Promise.resolve(),
    getHdrActive: () => Promise.resolve(hdr),
  };
}

async function shareSharp() {
  const { result } = renderHook(() => useGameDetection(true));
  act(() => detected(GAME));
  await act(async () => {
    await result.current.shareGame(() => {});
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function toastMessages() {
  return useToastStore.getState().toasts.map((t) => t.message);
}

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  useVoiceStore.setState({ smoothCaptureSupported: true, screenShareMode: "sharp" });
});

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("useGameDetection sharing sharp", () => {
  it("should warn about HDR and point at smooth", async () => {
    installElectron(true);
    await shareSharp();
    expect(toastMessages()).toContain("voice:screenHdrSharpWarning");
  });

  it("should say nothing when no display is in HDR", async () => {
    installElectron(false);
    await shareSharp();
    expect(toastMessages()).toEqual([]);
  });

  it("should not point at smooth after smooth just failed to start", async () => {
    installElectron(true);
    useVoiceStore.setState({
      screenShareMode: "smooth",
      startNativeSmoothCapture: () => Promise.resolve({ ok: false }),
    });
    await shareSharp();
    expect(toastMessages()).toContain("voice:screenHdrNoSmoothWarning");
    expect(toastMessages()).not.toContain("voice:screenHdrSharpWarning");
  });
});
