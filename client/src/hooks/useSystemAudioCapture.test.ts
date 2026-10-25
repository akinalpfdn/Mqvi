/**
 * How a share-audio start comes out, and when a running capture ending on its own is reported.
 * The owner warns on "failed" and stays quiet on "unavailable"; a capture that ends after its
 * track went out must be reported, or the published track stays on silent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useSystemAudioCapture, type ShareAudioStartResult } from "./useSystemAudioCapture";

const HEADER = { sampleRate: 48_000, channels: 2, bitsPerSample: 32, formatTag: 3 };

let onHeader: ((header: typeof HEADER) => Promise<void>) | null = null;
let onStopped: (() => void) | null = null;
let spawned = true;

function installElectron() {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    removeCaptureListeners: () => {
      onHeader = null;
      onStopped = null;
    },
    onCaptureAudioError: () => {},
    onCaptureAudioHeader: (cb: typeof onHeader) => (onHeader = cb),
    onCaptureAudioData: () => {},
    onCaptureAudioStopped: (cb: typeof onStopped) => (onStopped = cb),
    startSystemCapture: () => Promise.resolve(spawned),
    stopSystemCapture: () => Promise.resolve(),
  };
}

class FakeAudioContext {
  audioWorklet = { addModule: () => Promise.resolve() };
  createMediaStreamDestination() {
    return { stream: { getAudioTracks: () => [{ stop: () => {} }] }, disconnect: () => {} };
  }
  close() {
    return Promise.resolve();
  }
}

class FakeAudioWorkletNode {
  port = { postMessage: () => {} };
  connect() {}
  disconnect() {}
}

function startCapture(onEnded = vi.fn()) {
  const { result } = renderHook(() => useSystemAudioCapture());
  let started!: Promise<ShareAudioStartResult>;
  act(() => {
    started = result.current.start("window:1:0", onEnded);
  });
  return { started, onEnded };
}

beforeEach(() => {
  spawned = true;
  installElectron();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe("useSystemAudioCapture", () => {
  it("should report the capture ending on its own after its track was handed over", async () => {
    const { started, onEnded } = startCapture();
    await act(async () => {
      await onHeader?.(HEADER);
    });
    expect((await started).status).toBe("started");

    act(() => onStopped?.());

    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("should fail and report nothing more when the capture ends before its header", async () => {
    const { started, onEnded } = startCapture();

    act(() => onStopped?.());

    expect(await started).toEqual({ status: "failed" });
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("should say unavailable when this platform has no share audio", async () => {
    spawned = false;
    const { started } = startCapture();

    expect(await started).toEqual({ status: "unavailable" });
  });

  it("should keep waiting for a header past both of the mac helper's 5 s limits", async () => {
    vi.useFakeTimers();
    const { started } = startCapture();
    act(() => {
      vi.advanceTimersByTime(10_500);
    });

    await act(async () => {
      await onHeader?.(HEADER);
    });

    expect((await started).status).toBe("started");
  });

  it("should fail, and report nothing later, when the header never comes", async () => {
    vi.useFakeTimers();
    const { started, onEnded } = startCapture();
    act(() => {
      vi.advanceTimersByTime(12_000);
    });
    expect(await started).toEqual({ status: "failed" });

    await act(async () => {
      await onHeader?.(HEADER);
    });
    act(() => onStopped?.());

    expect(onEnded).not.toHaveBeenCalled();
  });
});
