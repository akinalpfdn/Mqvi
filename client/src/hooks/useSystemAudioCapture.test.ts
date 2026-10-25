/**
 * A share's audio capture can end on its own after its track went out: the system stops it, its
 * capture service fails, the shared window closes. The owner must hear about that, or the published
 * track stays on silent and the user believes viewers still hear the share.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useSystemAudioCapture } from "./useSystemAudioCapture";

const HEADER = { sampleRate: 48_000, channels: 2, bitsPerSample: 32, formatTag: 3 };

let onHeader: ((header: typeof HEADER) => Promise<void>) | null = null;
let onStopped: (() => void) | null = null;

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
    startSystemCapture: () => Promise.resolve(),
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

beforeEach(() => {
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
    const onEnded = vi.fn();
    const { result } = renderHook(() => useSystemAudioCapture());
    let started!: Promise<MediaStreamTrack | null>;
    act(() => {
      started = result.current.start("window:1:0", onEnded);
    });
    await act(async () => {
      await onHeader?.(HEADER);
    });
    expect(await started).not.toBeNull();

    act(() => onStopped?.());

    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("should resolve null and report nothing when the capture ends before its header", async () => {
    const onEnded = vi.fn();
    const { result } = renderHook(() => useSystemAudioCapture());
    let started!: Promise<MediaStreamTrack | null>;
    act(() => {
      started = result.current.start("window:1:0", onEnded);
    });

    act(() => onStopped?.());

    expect(await started).toBeNull();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("should report nothing when the capture ends after the header came too late", async () => {
    vi.useFakeTimers();
    const onEnded = vi.fn();
    const { result } = renderHook(() => useSystemAudioCapture());
    let started!: Promise<MediaStreamTrack | null>;
    act(() => {
      started = result.current.start("window:1:0", onEnded);
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(await started).toBeNull();

    await act(async () => {
      await onHeader?.(HEADER);
    });
    act(() => onStopped?.());

    expect(onEnded).not.toHaveBeenCalled();
  });
});
